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

  constructor(server: DM) {
    super(server);

    // Get configuration
    this.mailAttr = (this.config.mail_attribute as string) || 'mail';
    this.applicativeAccountBase = this.config
      .applicative_account_base as string;
    this.operationalAttributes = (this.config.ldap_operational_attributes as string[]) || [];

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
   * Check if an attribute should be excluded when copying LDAP entry attributes
   * @param key - The attribute name to check
   * @returns true if the attribute should be excluded
   */
  private shouldExcludeAttribute(key: string): boolean {
    return this.operationalAttributes.includes(key);
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
    const applicativeDn = `uid=${mail},${this.applicativeAccountBase}`;

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

      // Create applicative account entry with same attributes but uid changed to mail
      // Filter out operational attributes and userPassword (let API set passwords separately)
      const applicativeAttrs: AttributesList = {};
      for (const [key, value] of Object.entries(userEntry)) {
        // Skip operational attributes
        if (this.shouldExcludeAttribute(key)) {
          continue;
        }
        // Skip empty values
        if (value === undefined || value === null) {
          continue;
        }
        // Skip empty arrays
        if (Array.isArray(value) && value.length === 0) {
          continue;
        }
        applicativeAttrs[key] = value;
      }

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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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

        // Compute new DN based on account type
        let newApplicativeDn: string;
        if (isPrincipalAccount) {
          newApplicativeDn = `uid=${newMail},${this.applicativeAccountBase}`;
        } else {
          // Keep the same uid for applicative accounts
          newApplicativeDn = `uid=${oldUid},${this.applicativeAccountBase}`;
        }

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
          try {
            await this.server.ldap.delete(oldApplicativeDn);
            this.logger.info(
              `${this.name}: Deleted old applicative account ${oldApplicativeDn}`
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (deleteError: any) {
            // Ignore NoSuchObjectError (already deleted)
            if (
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              deleteError.code === 0x20 ||
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
              deleteError.message?.includes('NoSuchObject')
            ) {
              this.logger.debug(
                `${this.name}: Applicative account ${oldApplicativeDn} already deleted`
              );
            } else {
              throw deleteError;
            }
          }

          // Create new applicative account with updated mail
          // Start with old applicative account attributes to preserve things like description, userPassword
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
          for (const [key, value] of Object.entries(userEntry)) {
            // Skip operational attributes
            if (this.shouldExcludeAttribute(key)) {
              continue;
            }
            // Skip empty values
            if (value === undefined || value === null) {
              continue;
            }
            // Skip empty arrays
            if (Array.isArray(value) && value.length === 0) {
              continue;
            }
            newAttrs[key] = value;
          }

          // For principal account: change uid to newMail
          // For applicative accounts: keep the same uid (username_cXXXXXXXX)
          if (isPrincipalAccount) {
            newAttrs.uid = newMail;
          } else {
            // Keep the same uid for applicative accounts
            newAttrs.uid = oldUid;
          }

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
