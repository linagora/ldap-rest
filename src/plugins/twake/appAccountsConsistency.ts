/**
 * App Accounts Consistency Plugin
 *
 * Automatically manages applicative account entries for protocol-based authentication
 * (e.g., IMAP, SMTP, CalDAV, CardDAV).
 *
 * ## Concept
 *
 * Instead of using a single primary password for all services, this system separates:
 * - **Primary authentication**: May use passwordless methods (smart cards, biometrics, SSO)
 * - **Applicative accounts**: Dedicated accounts per device/application
 *
 * This is essential for protocols requiring password authentication (IMAP, SMTP, CalDAV)
 * while maintaining security and allowing easy revocation per device.
 *
 * ## Behavior
 *
 * When a user with a mail attribute is created, this plugin creates a corresponding
 * principal applicative account entry in a separate branch (e.g., ou=applicative).
 *
 * When a user is deleted, all corresponding applicative accounts are also deleted.
 *
 * When a user's mail changes, all applicative accounts are updated with the new mail.
 */

import DmPlugin from '../../abstract/plugin';
import type { Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import { Hooks } from '../../hooks';
import { escapeDnValue, isDnInBranch } from '../../lib/utils';

export default class AppAccountsConsistency extends DmPlugin {
  name = 'appAccountsConsistency';
  roles: Role[] = ['consistency'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
  };

  // Configuration
  private mailAttr: string;
  private applicativeAccountBase: string;
  private operationalAttributes: string[];
  private copiedAttributes: Set<string>;

  constructor(server: DM) {
    super(server);

    // Get configuration
    this.mailAttr = (this.config.mail_attribute as string) || 'mail';
    this.applicativeAccountBase = this.config
      .applicative_account_base as string;
    this.operationalAttributes =
      (this.config.ldap_operational_attribute as string[]) || [];
    // The mail attribute is what the applicative entry is keyed on, so it is
    // always copied whatever the configured list says.
    this.copiedAttributes = new Set([
      ...((this.config.applicative_account_attribute as string[]) || []),
      this.mailAttr,
    ]);

    if (!this.applicativeAccountBase) {
      throw new Error(
        `${this.name}: applicative_account_base configuration is required`
      );
    }

    this.logger.info(
      `${this.name}: initialized with applicative_account_base=${this.applicativeAccountBase}`
    );
  }

  /**
   * Check if an attribute should be excluded when recreating an existing
   * applicative entry from its own current state.
   *
   * This is a denylist because the input is an entry we wrote ourselves: what
   * has to go is what the directory generates and would refuse on an `add`,
   * plus `userPassword` (an app account is reconfigured on every client after
   * a mail change anyway, so its password is deliberately not carried over).
   *
   * Attributes coming from the *user* entry are chosen by
   * {@link pickCopiedAttributes} instead — an allowlist, so that a new
   * attribute on the user schema is never propagated by accident.
   *
   * @param key - The attribute name to check
   * @returns true if the attribute should be excluded
   */
  private shouldExcludeAttribute(key: string): boolean {
    // `dn` is the entry's distinguished name, never a real attribute — exclude
    // it unconditionally so that a misconfigured operational attribute list
    // cannot lead to "LDAP add error: UndefinedTypeError: dn" failures.
    if (key === 'dn') return true;
    return this.operationalAttributes.includes(key);
  }

  /**
   * Delete an entry of the applicative branch, tolerating its absence.
   *
   * A missing entry is the state we wanted, so `NoSuchObject` is not an error:
   * it keeps the mail-change path idempotent when a hook fires twice.
   *
   * @param dn - DN of the applicative entry to remove
   * @throws whatever the directory raised, except NoSuchObject
   */
  private async deleteApplicativeEntry(dn: string): Promise<void> {
    try {
      await this.server.ldap.delete(dn);
      this.logger.info(`${this.name}: Deleted applicative account ${dn}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (deleteError: any) {
      if (
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        deleteError.code === 0x20 ||
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        deleteError.message?.includes('NoSuchObject')
      ) {
        this.logger.debug(
          `${this.name}: Applicative account ${dn} already deleted`
        );
        return;
      }
      throw deleteError;
    }
  }

  /**
   * Select the attributes to copy from a user entry into an applicative entry.
   *
   * An allowlist (`--applicative-account-attribute`, plus the mail attribute):
   * the applicative branch is only ever read to bind with `uid` and
   * `userPassword`, so anything else the user entry happens to carry —
   * recovery addresses, e2ee key material, whatever the schema grows next —
   * has no reason to be duplicated there.
   *
   * @param entry - The source user entry
   * @returns The subset worth copying, empty values dropped
   */
  private pickCopiedAttributes(entry: AttributesList): AttributesList {
    const picked: AttributesList = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!this.copiedAttributes.has(key)) continue;
      // Skip empty values
      if (value === undefined || value === null) continue;
      // Skip empty arrays
      if (Array.isArray(value) && value.length === 0) continue;
      picked[key] = value;
    }
    return picked;
  }

  /**
   * Whether a DN belongs to the applicative branch this plugin manages.
   *
   * Entries under `applicative_account_base` are *outputs* of this plugin
   * (principal and app accounts), never source users. Since every LDAP write
   * re-fires the change hooks — including our own writes — we must ignore
   * events originating in this branch. Otherwise creating/renaming/deleting an
   * applicative entry would re-enter `onLdapMailChange` and cause spurious
   * `AlreadyExists` attempts or a re-entrant deletion cascade during a mail
   * change.
   *
   * @param dn - The DN that changed
   * @returns true if `dn` is the applicative base itself or sits below it
   */
  private isInApplicativeBranch(dn: string): boolean {
    // Robust, RDN-by-RDN comparison (case/whitespace/escape-insensitive). A raw
    // string suffix match can false-negative on real-world DN formatting
    // differences between the configured base and what the LDAP server returns,
    // which would let a re-entrant delete event slip through and cascade.
    return isDnInBranch(dn, this.applicativeAccountBase);
  }

  hooks: Hooks = {
    /**
     * Handle mail changes, including creation (null → mail) and deletion (mail → null)
     */
    onLdapMailChange: async (
      dn: string,
      oldMail: AttributeValue | null,
      newMail: AttributeValue | null
    ) => {
      // Ignore changes on our own applicative entries: they are managed by
      // this plugin, never source users. This prevents re-entrant hook firing
      // (idempotent AlreadyExists churn, or a deletion cascade during a mail
      // change) when the applicative branch sits under `ldap_base`.
      if (this.isInApplicativeBranch(dn)) {
        this.logger.debug(
          `${this.name}: Ignoring mail change event originating in the applicative branch`
        );
        return;
      }

      try {
        const oldMailStr =
          oldMail !== null && oldMail !== undefined
            ? Array.isArray(oldMail)
              ? String(oldMail[0])
              : String(oldMail)
            : null;
        const newMailStr =
          newMail !== null && newMail !== undefined
            ? Array.isArray(newMail)
              ? String(newMail[0])
              : String(newMail)
            : null;

        // Case 1: Creation (null → mail)
        if (!oldMailStr && newMailStr) {
          await this.createApplicativeAccount(dn, newMailStr);
          return;
        }

        // Case 2: Deletion (mail → null)
        if (oldMailStr && !newMailStr) {
          await this.deleteApplicativeAccount(oldMailStr);
          return;
        }

        // Case 3: Update (mail → newMail)
        if (oldMailStr && newMailStr && oldMailStr !== newMailStr) {
          await this.updateApplicativeAccount(dn, oldMailStr, newMailStr);
          return;
        }
      } catch (error) {
        this.logger.error(
          `${this.name}: Failed to handle mail change for ${dn}:`,
          error
        );
      }
    },
  };

  /**
   * Create applicative account for a user
   */
  private async createApplicativeAccount(
    userDn: string,
    mail: string
  ): Promise<void> {
    const applicativeDn = `uid=${escapeDnValue(mail)},${this.applicativeAccountBase}`;

    try {
      // Read user attributes
      const userResult = await this.server.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        userDn
      );

      const userEntry = (userResult as SearchResult).searchEntries?.[0];
      if (!userEntry) {
        this.logger.warn(
          `${this.name}: Could not find user ${userDn} to create applicative account`
        );
        return;
      }

      // Create the applicative entry from the named subset of the user entry.
      // No password is set here: the app-account API issues one per device.
      const applicativeAttrs = this.pickCopiedAttributes(userEntry);

      // Update uid to mail
      applicativeAttrs.uid = mail;

      await this.server.ldap.add(applicativeDn, applicativeAttrs);

      this.logger.info(
        `${this.name}: Created applicative account ${applicativeDn} for user ${userDn}`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // Ignore AlreadyExistsError (idempotent)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      if (error.code === 0x44 || error.message?.includes('AlreadyExists')) {
        this.logger.debug(
          `${this.name}: Applicative account ${applicativeDn} already exists`
        );
        return;
      }
      this.logger.error(
        `${this.name}: Failed to create applicative account for ${userDn}:`,
        error
      );
    }
  }

  /**
   * Delete applicative account by mail
   */
  private async deleteApplicativeAccount(mail: string): Promise<void> {
    try {
      // Search for applicative accounts by mail attribute
      const filter = `(${this.mailAttr}=${mail})`;

      const result = await this.server.ldap.search(
        {
          filter,
          scope: 'sub',
          paged: false,
        },
        this.applicativeAccountBase
      );

      const searchEntries = (result as SearchResult).searchEntries || [];

      if (searchEntries.length === 0) {
        this.logger.debug(
          `${this.name}: No applicative accounts found for mail ${mail}`
        );
        return;
      }

      // Delete all found applicative accounts
      for (const entry of searchEntries) {
        const applicativeDn = entry.dn;
        try {
          await this.server.ldap.delete(applicativeDn);
          this.logger.info(
            `${this.name}: Deleted applicative account ${applicativeDn}`
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (deleteError: any) {
          // Ignore NoSuchObjectError (already deleted - idempotent)
          if (
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            deleteError.code === 0x20 ||
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
            deleteError.message?.includes('NoSuchObject')
          ) {
            this.logger.debug(
              `${this.name}: Applicative account ${applicativeDn} already deleted`
            );
          } else {
            this.logger.error(
              `${this.name}: Failed to delete applicative account ${applicativeDn}:`,
              deleteError
            );
          }
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // Ignore NoSuchObjectError if the applicative account base doesn't exist
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      if (error.code === 0x20 || error.message?.includes('NoSuchObject')) {
        this.logger.debug(
          `${this.name}: Applicative account base does not exist or no accounts found for mail ${mail}`
        );
        return;
      }
      this.logger.error(
        `${this.name}: Failed to delete applicative account for mail ${mail}:`,
        error
      );
    }
  }

  /**
   * Update applicative account when mail changes
   */
  private async updateApplicativeAccount(
    userDn: string,
    oldMail: string,
    newMail: string
  ): Promise<void> {
    try {
      // Search for the old applicative account
      const filter = `(${this.mailAttr}=${oldMail})`;
      const result = await this.server.ldap.search(
        {
          filter,
          scope: 'sub',
          paged: false,
        },
        this.applicativeAccountBase
      );

      const searchEntries = (result as SearchResult).searchEntries || [];

      if (searchEntries.length === 0) {
        this.logger.debug(
          `${this.name}: No applicative account found for old mail ${oldMail}`
        );
        return;
      }

      for (const entry of searchEntries) {
        const oldApplicativeDn = entry.dn;
        const oldUid = Array.isArray(entry.uid)
          ? String(entry.uid[0])
          : String(entry.uid);

        // Distinguish between principal account (uid=mail) and applicative accounts (uid=username_cXXXXXXXX)
        const isPrincipalAccount = oldUid === oldMail;

        // App accounts do not survive a mail change: every MUA has to be
        // reconfigured against the new address anyway, and a per-device
        // credential left bound to the old identity is a liability. Drop them
        // and let the user reissue what they still need.
        //
        // They used to be recreated at the same DN carrying the new mail but
        // without their password — entries that could not authenticate, were
        // still listed by the API as if they could, and still counted against
        // `max_app_accounts`, eventually locking the user out of creating new
        // ones (#103).
        if (!isPrincipalAccount) {
          await this.deleteApplicativeEntry(oldApplicativeDn);
          continue;
        }

        const newApplicativeDn = `uid=${escapeDnValue(newMail)},${this.applicativeAccountBase}`;

        try {
          // Save old applicative account entry attributes before deletion
          // This preserves attributes like description that don't exist in user entry
          const oldApplicativeAttrs: AttributesList = {};
          for (const [key, value] of Object.entries(entry)) {
            // Skip operational attributes
            if (this.shouldExcludeAttribute(key)) {
              continue;
            }
            if (value === undefined || value === null) {
              continue;
            }
            if (Array.isArray(value) && value.length === 0) {
              continue;
            }
            oldApplicativeAttrs[key] = value;
          }

          // Delete old applicative account
          await this.deleteApplicativeEntry(oldApplicativeDn);

          // Recreate the principal at its new DN. Start from the old entry's
          // own attributes to keep what the user entry cannot supply, then
          // overwrite with the fresh user values below.
          const newAttrs: AttributesList = { ...oldApplicativeAttrs };

          // Read the current user entry to get fresh user attributes
          const userResult = await this.server.ldap.search(
            {
              scope: 'base',
              paged: false,
            },
            userDn
          );

          const userEntry = (userResult as SearchResult).searchEntries?.[0];
          if (!userEntry) {
            this.logger.warn(
              `${this.name}: Could not find user ${userDn} to update applicative account`
            );
            return;
          }

          // Overwrite with fresh user attributes (cn, sn, givenName, mail, etc.)
          Object.assign(newAttrs, this.pickCopiedAttributes(userEntry));

          // The principal account is keyed on the mail address
          newAttrs.uid = newMail;

          await this.server.ldap.add(newApplicativeDn, newAttrs);
          this.logger.info(
            `${this.name}: Created new applicative account ${newApplicativeDn} (mail changed from ${oldMail} to ${newMail})`
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          // Ignore AlreadyExistsError (idempotent)
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          if (error.code === 0x44 || error.message?.includes('AlreadyExists')) {
            this.logger.debug(
              `${this.name}: Applicative account ${newApplicativeDn} already exists after mail change`
            );
            return;
          }
          this.logger.error(
            `${this.name}: Failed to update applicative account for mail change:`,
            error
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `${this.name}: Failed to update applicative account for ${userDn}:`,
        error
      );
    }
  }
}
