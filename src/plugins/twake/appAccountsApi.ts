/**
 * @module plugins/twake/appAccountsApi
 *
 * API plugin for managing applicative accounts (device/app accounts)
 * Provides endpoints for listing, creating, and deleting applicative accounts
 */
import { randomInt } from 'crypto';

import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { SearchResult } from '../../lib/ldapActions';
import { wantJson } from '../../lib/expressFormatedResponses';
import { escapeDnValue, escapeLdapFilter, isDnInBranch } from '../../lib/utils';

/**
 * @openapi-component
 * AppAccount:
 *   type: object
 *   description: |
 *     An application-specific identity attached to a user.  App accounts
 *     allow a single principal user to authenticate as different named
 *     "devices" or "applications" each with its own credential, while
 *     sharing the same mail address.
 *   required: [uid]
 *   properties:
 *     uid:
 *       type: string
 *       description: |
 *         Unique identifier of the app account.  Format:
 *         `<prefix>_c<8-digits>`, where `<prefix>` is the `:user` path param
 *         (the resolution value — the mail by default) sanitized into a
 *         uid-safe token (e.g. `alice@example.com` -> `alice_example_com`).
 *       example: alice_example_com_c04729183
 *     name:
 *       type: string
 *       description: Human-readable label (stored as LDAP `description`).
 *       example: Work laptop
 *   example:
 *     uid: alice_c04729183
 *     name: Work laptop
 * AppAccountCreated:
 *   type: object
 *   description: |
 *     Response returned when a new app account is successfully created.
 *     The one-time cleartext password is included here and never returned
 *     again — callers must store it immediately.
 *   required: [uid, pwd, mail]
 *   properties:
 *     uid:
 *       type: string
 *       description: Identifier of the newly created app account.
 *       example: alice_c04729183
 *     pwd:
 *       type: string
 *       description: |
 *         One-time cleartext password generated for this account.
 *         Format: 6 blocks of 4 characters separated by `-`
 *         (e.g. `Ab3@-xYz!-9pQ#-Sv4$-mN8!-pQ5@`).
 *         OpenLDAP hashes it via ppolicy before storage.
 *       example: Ab3@-xYz!-9pQ#-Sv4$-mN8!-pQ5@
 *     mail:
 *       type: string
 *       description: Mail address of the principal account this app account belongs to.
 *       example: alice@example.com
 *   example:
 *     uid: alice_c04729183
 *     pwd: Ab3@-xYz!-9pQ#-Sv4$-mN8!-pQ5@
 *     mail: alice@example.com
 * AppAccountCreate:
 *   type: object
 *   description: Request body for creating a new app account.
 *   properties:
 *     name:
 *       type: string
 *       description: Optional human-readable label for the new account.
 *       example: Work laptop
 *   example:
 *     name: Work laptop
 */
export default class AppAccountsApi extends DmPlugin {
  name = 'appAccountsApi';
  roles: Role[] = ['api', 'configurable'] as const;
  dependencies = {
    appAccountsConsistency: 'core/twake/appAccountsConsistency',
  };

  private applicativeAccountBase: string;
  private maxAppAccounts: number;
  private mailAttr: string;
  // Attribute used to resolve the `:user` path param to the principal entry.
  // Defaults to the (unique) mail attribute; set to `uid` for the legacy
  // pre-#89 contract where `:user` is the LDAP uid. The app-account uid is
  // prefixed from this (unique) `:user` value, sanitized — so with uid it stays
  // `<uid>_c<digits>`, and with mail it becomes `<sanitized-mail>_c<digits>`.
  private userAttr: string;

  constructor(server: DM) {
    super(server);

    this.applicativeAccountBase = this.config
      .applicative_account_base as string;
    this.maxAppAccounts = (this.config.max_app_accounts as number) || 5;
    this.mailAttr = (this.config.mail_attribute as string) || 'mail';
    this.userAttr =
      (this.config.app_accounts_user_attribute as string) || this.mailAttr;

    if (!this.applicativeAccountBase) {
      throw new Error(
        `${this.name}: applicative_account_base configuration is required`
      );
    }

    this.logger.info(
      `${this.name}: initialized with applicative_account_base=${this.applicativeAccountBase}, max_app_accounts=${this.maxAppAccounts}, user_attribute=${this.userAttr}`
    );
  }

  /**
   * Register API routes
   */
  api(app: Express): void {
    const apiPrefix = this.config.api_prefix || '/api';

    /**
     * @openapi
     * summary: List app accounts for a user
     * description: |
     *   Returns all application-specific accounts belonging to `:user`, where
     *   `:user` is the principal account email (globally unique). Ownership is
     *   resolved by the mail attribute, not the LDAP `uid`, which may repeat
     *   under different subtrees of the directory. The principal account
     *   (whose uid equals the mail address) is always filtered out.
     *
     *   Results are sorted alphabetically by `uid`.
     * responses:
     *   '200':
     *     description: List of app accounts.
     *     content:
     *       application/json:
     *         schema:
     *           type: array
     *           items: { $ref: '#/components/schemas/AppAccount' }
     *         example:
     *           - uid: alice_c04729183
     *             name: Work laptop
     *           - uid: alice_c09812345
     *             name: Mobile phone
     *   '404':
     *     description: User not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // List applicative accounts for a user
    app.get(
      `${apiPrefix}/v1/users/:user/app-accounts`,
      (req: Request, res: Response) => this.listAccounts(req, res)
    );

    /**
     * @openapi
     * summary: Create an app account for a user
     * description: |
     *   Creates a new application-specific identity under the configured
     *   applicative-account LDAP branch.  The server generates a random
     *   uid (`<prefix>_c<8-digits>`, prefix derived from `:user`) and a
     *   cryptographically secure password, then:
     *
     *   1. Copies `cn`, `sn`, `givenName`, `mail`, and `displayName` from
     *      the principal user entry.
     *   2. Adds the cleartext password to the principal account
     *      (`uid=<mail>`) so single-point authentication still works.
     *
     *   Returns a `400` if the user has already reached the server-side
     *   maximum number of app accounts (`max_app_accounts`, default 5).
     *
     *   **The generated password is returned only once** — store it
     *   immediately.
     * requestBody:
     *   required: false
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/AppAccountCreate' }
     *       example:
     *         name: Work laptop
     * responses:
     *   '200':
     *     description: App account created — includes the one-time password.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/AppAccountCreated' }
     *         example:
     *           uid: alice_c04729183
     *           pwd: Ab3@-xYz!-9pQ#-Sv4$-mN8!-pQ5@
     *           mail: alice@example.com
     *   '400':
     *     description: User has no mail attribute or maximum account limit reached.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: User not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Create a new applicative account
    app.post(
      `${apiPrefix}/v1/users/:user/app-accounts`,
      (req: Request, res: Response) => this.createAccount(req, res)
    );

    /**
     * @openapi
     * summary: Delete an app account
     * description: |
     *   Deletes the app account identified by `:uid` and removes its
     *   password from the principal account (`uid=<mail>`). `:user` is the
     *   principal account email.
     *
     *   The target account's mail must match `:user` — attempting to delete an
     *   account that belongs to a different principal returns `403`.
     *
     *   The operation is **idempotent**: if the account does not exist,
     *   the response is still `200` with the `uid` echoed back.
     * responses:
     *   '200':
     *     description: App account deleted (or was already absent).
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             uid:
     *               type: string
     *               description: UID of the deleted account.
     *         example:
     *           uid: alice_c04729183
     *   '403':
     *     description: The `:uid` does not belong to `:user`.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Delete an applicative account
    app.delete(
      `${apiPrefix}/v1/users/:user/app-accounts/:uid`,
      (req: Request, res: Response) => this.deleteAccount(req, res)
    );

    this.logger.info(
      `AppAccounts API registered at ${apiPrefix}/v1/users/:user/app-accounts`
    );
  }

  /**
   * Resolve the principal user entry from the `:user` path param.
   *
   * `:user` is matched against the configured resolution attribute
   * (`app_accounts_user_attribute`, default the mail attribute). Mail is
   * globally unique; resolving by the LDAP `uid` instead is only safe when uid
   * is unique directory-wide, as the same `uid` may repeat under different
   * subtrees and resolve to an arbitrary same-named user (see #88).
   *
   * On failure (no match, or an ambiguous one) this writes the HTTP error
   * response and returns null, so callers can simply `return` when it does.
   *
   * @param principal - The `:user` path param value
   * @param res - The Express response, used to emit error statuses
   * @param attributes - Optional attribute projection for the search
   * @returns The single matching LDAP entry, or null when none/ambiguous
   */
  private async resolvePrincipal(
    principal: string,
    res: Response,
    attributes?: string[]
  ): Promise<SearchResult['searchEntries'][number] | null> {
    const result = await this.server.ldap.search(
      {
        scope: 'sub',
        filter: `(${this.userAttr}=${escapeLdapFilter(principal)})`,
        paged: false,
        ...(attributes ? { attributes } : {}),
      },
      this.config.ldap_base || ''
    );

    // The applicative branch lives under ldap_base and its entries (the
    // principal account and the app accounts) carry the same mail, so exclude
    // them: only a real user entry can be the principal.
    const entries = ((result as SearchResult).searchEntries || []).filter(
      entry => !isDnInBranch(entry.dn, this.applicativeAccountBase)
    );

    if (entries.length === 0) {
      res.status(404).json({ error: `User ${principal} not found` });
      return null;
    }

    if (entries.length > 1) {
      this.logger.error(
        `${this.name}: Ambiguous principal lookup for ${principal}: ${entries.length} entries share ${this.userAttr}`
      );
      res.status(409).json({
        error: `Multiple users share ${this.userAttr} ${principal}`,
      });
      return null;
    }

    return entries[0];
  }

  /**
   * List applicative accounts for a user
   */
  private async listAccounts(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const principal = req.params.user as string;

    try {
      const userEntry = await this.resolvePrincipal(principal, res, [
        this.mailAttr,
      ]);
      if (!userEntry) return;

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${principal} has no mail attribute` });
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // Search for applicative accounts with this mail
      const accountsResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(${this.mailAttr}=${escapeLdapFilter(mailStr)})`,
          paged: false,
        },
        this.applicativeAccountBase
      );

      const accounts = (accountsResult as SearchResult).searchEntries || [];

      // Ownership is the (unique) mail match above; the only non-app entry
      // sharing it is the principal account (uid=mail), dropped here. Compare
      // case-insensitively, as LDAP uid/mail matching is.
      const appAccounts = accounts
        .filter(entry => {
          const uid = entry.uid;
          const uidStr = Array.isArray(uid) ? String(uid[0]) : String(uid);
          return uidStr.toLowerCase() !== mailStr.toLowerCase();
        })
        .map(entry => {
          const uid = entry.uid;
          const uidStr = Array.isArray(uid) ? String(uid[0]) : String(uid);
          const desc = entry.description;
          const descStr = desc
            ? Array.isArray(desc)
              ? String(desc[0])
              : String(desc)
            : undefined;

          return {
            uid: uidStr,
            ...(descStr ? { name: descStr } : {}),
          };
        })
        .sort((a, b) => a.uid.localeCompare(b.uid));

      res.json(appAccounts);
    } catch (error) {
      this.logger.error(
        `${this.name}: Failed to list accounts for ${principal}:`,
        error
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Create a new applicative account
   */
  private async createAccount(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const principal = req.params.user as string;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { name } = req.body || {};

    try {
      const userEntry = await this.resolvePrincipal(principal, res);
      if (!userEntry) return;

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${principal} has no mail attribute` });
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // The app-account uid is prefixed from the (unique) `:user` value, not
      // from the entry's `uid`: the same `uid` may repeat across users, so a
      // uid-based prefix could collide in the shared applicative branch. The
      // value is sanitized into a uid-safe token; uniqueness is still enforced
      // globally below, so a lossy sanitization can never produce a clash.
      const prefix = this.appUidPrefix(principal);

      // Enforce the per-user limit, scoped by the unique principal mail.
      const accountsResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(${this.mailAttr}=${escapeLdapFilter(mailStr)})`,
          paged: false,
        },
        this.applicativeAccountBase
      );

      const accounts = (accountsResult as SearchResult).searchEntries || [];
      const existingAppAccounts = accounts.filter(entry => {
        const uid = entry.uid;
        const uidStr = Array.isArray(uid) ? String(uid[0]) : String(uid);
        return uidStr.toLowerCase() !== mailStr.toLowerCase();
      });

      if (existingAppAccounts.length >= this.maxAppAccounts) {
        res.status(400).json({
          error: `Maximum number of accounts (${this.maxAppAccounts}) reached`,
        });
        return;
      }

      // Generate a uid that is unique across the whole applicative branch (not
      // just within this principal), so distinct principals can never collide.
      let newUid: string;
      let attempts = 0;
      do {
        newUid = `${prefix}_${this.generateAccountId()}`;
        attempts++;
        if (attempts > 100) {
          throw new Error(
            'Failed to generate unique account ID after 100 attempts'
          );
        }
      } while (await this.uidExists(newUid));

      const newPassword = this.generatePassword();

      // Build attributes for new applicative account
      const newAttrs: Record<string, string | string[]> = {
        objectClass: ['inetOrgPerson'],
        uid: newUid,
        // SECURITY NOTE: Password is passed in cleartext intentionally.
        // OpenLDAP's ppolicy overlay automatically hashes passwords before storage.
        // Pre-hashing would fail ppolicy validation (it expects cleartext input).
        userPassword: newPassword,
      };

      // Copy relevant attributes from user
      const attrsToCopy = [
        'cn',
        'sn',
        'givenName',
        this.mailAttr,
        'displayName',
      ];
      for (const attr of attrsToCopy) {
        if (userEntry[attr]) {
          const value = userEntry[attr];
          // Convert Buffer to string if needed
          if (Array.isArray(value)) {
            newAttrs[attr] = value.map(v =>
              Buffer.isBuffer(v) ? v.toString() : String(v)
            );
          } else {
            newAttrs[attr] = Buffer.isBuffer(value)
              ? value.toString()
              : String(value);
          }
        }
      }

      // Add description if provided
      if (name) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        newAttrs.description = name;
      }

      // Create applicative account
      const applicativeDn = `uid=${escapeDnValue(newUid)},${this.applicativeAccountBase}`;
      await this.server.ldap.add(applicativeDn, newAttrs);

      this.logger.info(
        `${this.name}: Created applicative account ${applicativeDn} for user ${principal}`
      );

      // Add password to principal account (uid=mail)
      // The principal account stores all app account passwords for single-point authentication
      const principalDn = `uid=${escapeDnValue(mailStr)},${this.applicativeAccountBase}`;
      try {
        await this.server.ldap.modify(principalDn, {
          // SECURITY NOTE: Cleartext password is intentional - ppolicy hashes before storage
          add: { userPassword: newPassword },
        });
      } catch (error) {
        this.logger.warn(
          `${this.name}: Failed to add password to principal account ${principalDn}:`,
          error
        );
        // Not critical, continue
      }

      res.json({ uid: newUid, pwd: newPassword, mail: mailStr });
    } catch (error) {
      this.logger.error(
        `${this.name}: Failed to create account for ${principal}:`,
        error
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Derive a uid-safe prefix for app-account uids from the (unique) `:user`
   * value. Characters awkward in a uid/RDN (e.g. `@` and `.` in a mail) are
   * replaced with `_`. Sanitization may be lossy, but app-account uids are made
   * unique across the whole branch at creation time, so this never collides.
   */
  private appUidPrefix(principal: string): string {
    return principal.replace(/[^A-Za-z0-9_-]/g, '_');
  }

  /**
   * Whether a uid already exists anywhere under the applicative branch.
   */
  private async uidExists(uid: string): Promise<boolean> {
    const result = await this.server.ldap.search(
      {
        scope: 'sub',
        filter: `(uid=${escapeLdapFilter(uid)})`,
        paged: false,
        attributes: ['uid'],
      },
      this.applicativeAccountBase
    );
    return ((result as SearchResult).searchEntries || []).length > 0;
  }

  /**
   * Delete an applicative account
   */
  private async deleteAccount(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const principal = req.params.user as string;
    const uid = req.params.uid as string;

    try {
      // Search for the applicative account
      const accountResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(uid=${escapeLdapFilter(uid)})`,
          paged: false,
        },
        this.applicativeAccountBase
      );

      const accountEntry = (accountResult as SearchResult).searchEntries?.[0];
      if (!accountEntry) {
        this.logger.warn(
          `${this.name}: Account ${uid} already deleted or not found`
        );
        // Return success even if not found (idempotent)
        res.json({ uid });
        return;
      }

      // Get mail from account to find principal account
      const mail = accountEntry[this.mailAttr];
      const mailStr = mail
        ? Array.isArray(mail)
          ? String(mail[0])
          : String(mail)
        : null;

      // Ownership: the account's mail must match the principal's mail (the
      // unique owner key — the uid prefix is not, as the same short uid may
      // repeat under different subtrees). When `:user` is itself the mail we
      // compare directly; otherwise we resolve `:user` to the principal entry
      // and read its mail.
      let principalMail = principal;
      if (this.userAttr !== this.mailAttr) {
        const principalEntry = await this.resolvePrincipal(principal, res, [
          this.mailAttr,
        ]);
        if (!principalEntry) return;
        const pm = principalEntry[this.mailAttr];
        const pmStr = pm
          ? Array.isArray(pm)
            ? String(pm[0])
            : String(pm)
          : null;
        if (!pmStr) {
          res
            .status(400)
            .json({ error: `User ${principal} has no mail attribute` });
          return;
        }
        principalMail = pmStr;
      }

      if (!mailStr || mailStr.toLowerCase() !== principalMail.toLowerCase()) {
        res.status(403).json({
          error: `Account ${uid} does not belong to user ${principal}`,
        });
        return;
      }

      const userPassword = accountEntry.userPassword;
      if (!userPassword) {
        this.logger.warn(
          `${this.name}: Account ${uid} has no userPassword attribute`
        );
      }

      // Delete password from principal account if available
      if (userPassword) {
        const principalDn = `uid=${escapeDnValue(mailStr)},${this.applicativeAccountBase}`;
        try {
          const passwordToDelete = Array.isArray(userPassword)
            ? userPassword[0]
            : userPassword;
          await this.server.ldap.modify(principalDn, {
            delete: { userPassword: passwordToDelete },
          });
        } catch (error) {
          this.logger.warn(
            `${this.name}: Failed to delete password from principal account ${principalDn}:`,
            error
          );
          // Not critical, continue
        }
      }

      // Delete the applicative account
      const applicativeDn = accountEntry.dn;
      await this.server.ldap.delete(applicativeDn);

      this.logger.info(
        `${this.name}: Deleted applicative account ${applicativeDn}`
      );

      res.json({ uid });
    } catch (error) {
      this.logger.error(
        `${this.name}: Failed to delete account ${uid} for ${principal}:`,
        error
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Generate a cryptographically secure random account ID
   * Format: c + 8 random digits
   */
  private generateAccountId(): string {
    // Use crypto.randomInt for cryptographically secure random number generation
    const digits = randomInt(0, 100000000).toString().padStart(8, '0');
    return `c${digits}`;
  }

  /**
   * Generate a cryptographically secure random password
   * Format: 6 blocks of 4 characters separated by "-"
   * Example: AbC3@-2xYz!-9pQr@-St4v!-mN8#-pQ5$
   * Length: 29 characters (6*4 + 5 dashes)
   * Ensures: uppercase, lowercase, digit, special char in each block
   *
   * Note: Password is passed in cleartext to LDAP. OpenLDAP automatically hashes it
   * via ppolicy overlay before storage. This is the correct approach - attempting to
   * pre-hash would fail ppolicy validation.
   */
  private generatePassword(): string {
    const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const special = '@!#$%';

    const blocks: string[] = [];
    for (let i = 0; i < 6; i++) {
      // Ensure each block has at least one uppercase, lowercase, digit, special
      // Use crypto.randomInt for cryptographically secure random selection
      const upIdx = randomInt(0, upper.length);
      const lowIdx = randomInt(0, lower.length);
      const digIdx = randomInt(0, digits.length);
      const specIdx = randomInt(0, special.length);

      const chars = [
        upper[upIdx],
        lower[lowIdx],
        digits[digIdx],
        special[specIdx],
      ];

      // Shuffle the characters in this block using Fisher-Yates with crypto.randomInt
      for (let j = chars.length - 1; j > 0; j--) {
        const k = randomInt(0, j + 1);
        [chars[j], chars[k]] = [chars[k], chars[j]];
      }

      blocks.push(chars.join(''));
    }

    return blocks.join('-');
  }

  /**
   * Expose configuration for configApi
   */
  getConfigApiData(): Record<string, unknown> {
    const apiPrefix = this.config.api_prefix || '/api';

    return {
      enabled: true,
      base: this.applicativeAccountBase,
      maxAccounts: this.maxAppAccounts,
      mailAttribute: this.mailAttr,
      endpoints: {
        list: `${apiPrefix}/v1/users/:user/app-accounts`,
        create: `${apiPrefix}/v1/users/:user/app-accounts`,
        delete: `${apiPrefix}/v1/users/:user/app-accounts/:uid`,
      },
    };
  }
}
