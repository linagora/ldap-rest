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
 *         `<uid>_c<8-digits>`, where `<uid>` is the principal's LDAP uid
 *         (not the `:user` path param, which is the mail). e.g. `alice_c04729183`.
 *       example: alice_c04729183
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

  constructor(server: DM) {
    super(server);

    this.applicativeAccountBase = this.config
      .applicative_account_base as string;
    this.maxAppAccounts = (this.config.max_app_accounts as number) || 5;
    this.mailAttr = (this.config.mail_attribute as string) || 'mail';

    if (!this.applicativeAccountBase) {
      throw new Error(
        `${this.name}: applicative_account_base configuration is required`
      );
    }

    this.logger.info(
      `${this.name}: initialized with applicative_account_base=${this.applicativeAccountBase}, max_app_accounts=${this.maxAppAccounts}`
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
     *   uid (`<username>_c<8-digits>`) and a cryptographically secure
     *   password, then:
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
   * Resolve the principal user entry by its (globally unique) mail address.
   *
   * App accounts are keyed on the principal mail, never the LDAP `uid`: the
   * same `uid` may repeat under different subtrees of the directory, so a
   * `uid`-based lookup could resolve to an arbitrary same-named user.
   *
   * On failure (no match, or an ambiguous mail) this writes the HTTP error
   * response and returns null, so callers can simply `return` when it does.
   *
   * @param principalEmail - The principal account email (the `:user` path param)
   * @param res - The Express response, used to emit error statuses
   * @param attributes - Optional attribute projection for the search
   * @returns The single matching LDAP entry, or null when none/ambiguous
   */
  private async resolvePrincipal(
    principalEmail: string,
    res: Response,
    attributes?: string[]
  ): Promise<SearchResult['searchEntries'][number] | null> {
    const result = await this.server.ldap.search(
      {
        scope: 'sub',
        filter: `(${this.mailAttr}=${escapeLdapFilter(principalEmail)})`,
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
      res.status(404).json({ error: `User ${principalEmail} not found` });
      return null;
    }

    if (entries.length > 1) {
      this.logger.error(
        `${this.name}: Ambiguous principal lookup for ${principalEmail}: ${entries.length} entries share this mail`
      );
      res
        .status(409)
        .json({ error: `Multiple users share mail ${principalEmail}` });
      return null;
    }

    return entries[0];
  }

  /**
   * List applicative accounts for a user
   */
  private async listAccounts(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const principalEmail = req.params.user as string;

    try {
      const userEntry = await this.resolvePrincipal(principalEmail, res, [
        this.mailAttr,
      ]);
      if (!userEntry) return;

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${principalEmail} has no mail attribute` });
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
        `${this.name}: Failed to list accounts for ${principalEmail}:`,
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

    const principalEmail = req.params.user as string;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { name } = req.body || {};

    try {
      const userEntry = await this.resolvePrincipal(principalEmail, res);
      if (!userEntry) return;

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${principalEmail} has no mail attribute` });
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // The app-account uid keeps the documented `<uid>_c<digits>` format, so
      // it is prefixed with the principal's short uid resolved from the entry,
      // not the `:user` path param (which is the mail).
      const uidAttr = userEntry.uid;
      if (!uidAttr) {
        res
          .status(400)
          .json({ error: `User ${principalEmail} has no uid attribute` });
        return;
      }
      const shortUid = Array.isArray(uidAttr)
        ? String(uidAttr[0])
        : String(uidAttr);

      // Check existing accounts count (scoped by the unique principal mail)
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

      // Generate unique account ID
      let accountId: string;
      let attempts = 0;
      do {
        accountId = this.generateAccountId();
        attempts++;
        if (attempts > 100) {
          throw new Error(
            'Failed to generate unique account ID after 100 attempts'
          );
        }
      } while (
        existingAppAccounts.some(entry => {
          const uid = entry.uid;
          const uidStr = Array.isArray(uid) ? String(uid[0]) : String(uid);
          return uidStr === `${shortUid}_${accountId}`;
        })
      );

      const newUid = `${shortUid}_${accountId}`;
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
        `${this.name}: Created applicative account ${applicativeDn} for user ${principalEmail}`
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
        `${this.name}: Failed to create account for ${principalEmail}:`,
        error
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Delete an applicative account
   */
  private async deleteAccount(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const principalEmail = req.params.user as string;
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

      // Ownership: the account's mail must match the principal email. Mail is
      // the unique owner key; the uid prefix is not, as the same short uid may
      // repeat under different subtrees of the directory.
      if (!mailStr || mailStr.toLowerCase() !== principalEmail.toLowerCase()) {
        res.status(403).json({
          error: `Account ${uid} does not belong to user ${principalEmail}`,
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
        `${this.name}: Failed to delete account ${uid} for ${principalEmail}:`,
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
