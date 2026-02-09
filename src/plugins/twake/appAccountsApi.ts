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

export default class AppAccountsApi extends DmPlugin {
  name = 'appAccountsApi';
  roles: Role[] = ['api', 'configurable'] as const;
  dependencies = {
    authToken: 'core/auth/token',
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

    // List applicative accounts for a user
    app.get(
      `${apiPrefix}/v1/users/:user/app-accounts`,
      (req: Request, res: Response) => this.listAccounts(req, res)
    );

    // Create a new applicative account
    app.post(
      `${apiPrefix}/v1/users/:user/app-accounts`,
      (req: Request, res: Response) => this.createAccount(req, res)
    );

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
   * List applicative accounts for a user
   */
  private async listAccounts(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const username = req.params.user as string;

    try {
      // Get user's mail from LDAP
      const userResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(uid=${username})`,
          paged: false,
          attributes: [this.mailAttr],
        },
        this.config.ldap_base || ''
      );

      const userEntry = (userResult as SearchResult).searchEntries?.[0];
      if (!userEntry) {
        res.status(404).json({ error: `User ${username} not found` });
        return;
      }

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${username} has no mail attribute` });
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // Search for applicative accounts with this mail
      const accountsResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(${this.mailAttr}=${mailStr})`,
          paged: false,
        },
        this.applicativeAccountBase
      );

      const accounts = (accountsResult as SearchResult).searchEntries || [];

      // Filter out the principal account (uid=mail) and extract uid and name
      const appAccounts = accounts
        .filter(entry => {
          const uid = entry.uid;
          const uidStr = Array.isArray(uid) ? String(uid[0]) : String(uid);
          // Keep only applicative accounts (user_cXXXXXXXX format)
          return uidStr !== mailStr && uidStr.startsWith(`${username}_`);
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
        `${this.name}: Failed to list accounts for ${username}:`,
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

    const username = req.params.user as string;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { name } = req.body || {};

    try {
      // Get user's mail and attributes from LDAP
      const userResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(uid=${username})`,
          paged: false,
        },
        this.config.ldap_base || ''
      );

      const userEntry = (userResult as SearchResult).searchEntries?.[0];
      if (!userEntry) {
        res.status(404).json({ error: `User ${username} not found` });
        return;
      }

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${username} has no mail attribute` });
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // Check existing accounts count
      const accountsResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(${this.mailAttr}=${mailStr})`,
          paged: false,
        },
        this.applicativeAccountBase
      );

      const accounts = (accountsResult as SearchResult).searchEntries || [];
      const existingAppAccounts = accounts.filter(entry => {
        const uid = entry.uid;
        const uidStr = Array.isArray(uid) ? String(uid[0]) : String(uid);
        return uidStr !== mailStr && uidStr.startsWith(`${username}_`);
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
          return uidStr === `${username}_${accountId}`;
        })
      );

      const newUid = `${username}_${accountId}`;
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
      const applicativeDn = `uid=${newUid},${this.applicativeAccountBase}`;
      await this.server.ldap.add(applicativeDn, newAttrs);

      this.logger.info(
        `${this.name}: Created applicative account ${applicativeDn} for user ${username}`
      );

      // Add password to principal account (uid=mail)
      // The principal account stores all app account passwords for single-point authentication
      const principalDn = `uid=${mailStr},${this.applicativeAccountBase}`;
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
        `${this.name}: Failed to create account for ${username}:`,
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

    const username = req.params.user as string;
    const uid = req.params.uid as string;

    try {
      // Validate that uid belongs to this user
      if (!uid.startsWith(`${username}_`)) {
        res.status(403).json({
          error: `Account ${uid} does not belong to user ${username}`,
        });
        return;
      }

      // Search for the applicative account
      const accountResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(uid=${uid})`,
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

      const userPassword = accountEntry.userPassword;
      if (!userPassword) {
        this.logger.warn(
          `${this.name}: Account ${uid} has no userPassword attribute`
        );
      }

      // Get mail from account to find principal account
      const mail = accountEntry[this.mailAttr];
      const mailStr = mail
        ? Array.isArray(mail)
          ? String(mail[0])
          : String(mail)
        : null;

      // Delete password from principal account if available
      if (mailStr && userPassword) {
        const principalDn = `uid=${mailStr},${this.applicativeAccountBase}`;
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
        `${this.name}: Failed to delete account ${uid} for ${username}:`,
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
