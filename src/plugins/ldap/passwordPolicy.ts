/**
 * Password Policy plugin - Administration API for OpenLDAP ppolicy
 *
 * Provides REST endpoints to:
 * - Query password status (expiration, lockout, etc.)
 * - Unlock locked accounts
 * - List expiring passwords and locked accounts
 * - Validate password complexity (optional)
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express, Request, Response } from 'express';

import DmPlugin, {
  type Role,
  asyncHandler,
  BadRequestError,
  NotFoundError,
} from '../../abstract/plugin';
import type { SearchResult } from '../../lib/ldapActions';
import { escapeDnValue } from '../../lib/utils';

// ppolicy operational attributes to read
const PPOLICY_ATTRS = [
  'pwdChangedTime',
  'pwdAccountLockedTime',
  'pwdFailureTime',
  'pwdGraceUseTime',
  'pwdReset',
  'pwdPolicySubentry',
];

// ppolicy configuration attributes
const PPOLICY_CONFIG_ATTRS = [
  'pwdMaxAge',
  'pwdMinAge',
  'pwdInHistory',
  'pwdCheckQuality',
  'pwdMinLength',
  'pwdMaxFailure',
  'pwdLockout',
  'pwdLockoutDuration',
  'pwdGraceAuthNLimit',
  'pwdExpireWarning',
  'pwdMustChange',
  'pwdAllowUserChange',
];

// Special characters for password complexity validation
const SPECIAL_CHARS_REGEX = /[!@#$%^&*()_+\-=[\]{}|;:'",.<>?/]/;

interface PpolicyConfig {
  dn?: string;
  pwdMaxAge?: number;
  pwdMinAge?: number;
  pwdInHistory?: number;
  pwdCheckQuality?: number;
  pwdMinLength?: number;
  pwdMaxFailure?: number;
  pwdLockout?: boolean;
  pwdLockoutDuration?: number;
  pwdGraceAuthNLimit?: number;
  pwdExpireWarning?: number;
  pwdMustChange?: boolean;
  pwdAllowUserChange?: boolean;
}

interface PasswordStatus {
  dn: string;
  passwordSet: boolean;
  lastChanged: string | null;
  expiresAt: string | null;
  daysUntilExpiration: number | null;
  isExpired: boolean;
  isExpiringSoon: boolean;
  mustChange: boolean;
  isLocked: boolean;
  lockedAt: string | null;
  failureCount: number;
  graceLoginsUsed: number;
}

interface ExpiringUser {
  dn: string;
  uid: string | undefined;
  displayName: string | undefined;
  mail: string | undefined;
  expiresAt: string;
  daysUntilExpiration: number;
}

interface LockedAccount {
  dn: string;
  uid: string | undefined;
  displayName: string | undefined;
  mail: string | undefined;
  lockedAt: string | undefined;
  failureCount: number;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// LDAP entry with ppolicy operational attributes
interface LdapUserEntry {
  dn: string;
  userPassword?: string;
  uid?: string;
  cn?: string;
  displayName?: string;
  mail?: string;
  pwdChangedTime?: string;
  pwdAccountLockedTime?: string;
  pwdFailureTime?: string[];
  pwdGraceUseTime?: string[];
  pwdReset?: string;
  pwdPolicySubentry?: string;
}

// LDAP ppolicy configuration entry
interface LdapPolicyEntry {
  dn: string;
  pwdMaxAge?: string;
  pwdMinAge?: string;
  pwdInHistory?: string;
  pwdCheckQuality?: string;
  pwdMinLength?: string;
  pwdMaxFailure?: string;
  pwdLockout?: string;
  pwdLockoutDuration?: string;
  pwdGraceAuthNLimit?: string;
  pwdExpireWarning?: string;
  pwdMustChange?: string;
  pwdAllowUserChange?: string;
}

export default class PasswordPolicy extends DmPlugin {
  name = 'ldapPasswordPolicy';
  roles: Role[] = ['api', 'configurable'];

  private policyCache: PpolicyConfig | null = null;
  private policyCacheTime = 0;
  private readonly POLICY_CACHE_TTL = 60000; // 1 minute

  api(app: Express): void {
    const prefix = `${this.config.api_prefix}/v1`;

    // GET /password-policy - configuration
    app.get(
      `${prefix}/password-policy`,
      asyncHandler(async (_req: Request, res: Response) => {
        const policy = await this.readPolicyConfig();
        res.json(policy);
      })
    );

    // GET /users/:id/password-status
    app.get(
      `${prefix}/users/:id/password-status`,
      asyncHandler(async (req: Request, res: Response) => {
        const userId = Array.isArray(req.params.id)
          ? (req.params.id[0] as string)
          : req.params.id;
        const status = await this.getPasswordStatus(userId);
        res.json(status);
      })
    );

    // POST /users/:id/unlock
    app.post(
      `${prefix}/users/:id/unlock`,
      asyncHandler(async (req: Request, res: Response) => {
        const userId = Array.isArray(req.params.id)
          ? (req.params.id[0] as string)
          : req.params.id;
        await this.unlockAccount(userId);
        res.json({ success: true, message: 'Account unlocked' });
      })
    );

    // GET /password-policy/expiring-soon
    app.get(
      `${prefix}/password-policy/expiring-soon`,
      asyncHandler(async (req: Request, res: Response) => {
        const days =
          parseInt(req.query.days as string) ||
          (this.config.ppolicy_warn_days as number) ||
          14;
        const users = await this.findExpiringPasswords(days);
        res.json({ warningDays: days, users });
      })
    );

    // GET /password-policy/locked-accounts
    app.get(
      `${prefix}/password-policy/locked-accounts`,
      asyncHandler(async (_req: Request, res: Response) => {
        const accounts = await this.findLockedAccounts();
        res.json({ accounts });
      })
    );

    // POST /password/validate (optional)
    if (this.config.ppolicy_validate_complexity) {
      app.post(
        `${prefix}/password/validate`,
        // eslint-disable-next-line @typescript-eslint/require-await
        asyncHandler(async (req: Request, res: Response) => {
          const { password } = req.body as { password?: string };
          if (!password) throw new BadRequestError('password required');
          const result = this.validateComplexity(password);
          res.json(result);
        })
      );
    }
  }

  /**
   * Get password status for a user
   */
  private async getPasswordStatus(userId: string): Promise<PasswordStatus> {
    const dn = this.resolveUserDn(userId);

    try {
      // Search with operational attributes
      const result = (await this.server.ldap.search(
        {
          filter: '(objectClass=*)',
          scope: 'base',
          attributes: ['*', ...PPOLICY_ATTRS],
          paged: false,
        },
        dn
      )) as SearchResult;

      if (!result.searchEntries || result.searchEntries.length === 0) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      const entry = result.searchEntries[0] as LdapUserEntry;
      const policy = await this.readPolicyConfig();

      return this.calculateStatus(dn, entry, policy);
    } catch (error) {
      // Handle LDAP NoSuchObjectError (0x20)
      if (
        error instanceof Error &&
        (error.name === 'NoSuchObjectError' ||
          error.message.includes('0x20') ||
          error.message.includes('Code: 32'))
      ) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      throw error;
    }
  }

  /**
   * Calculate password status from LDAP entry and policy
   */
  private calculateStatus(
    dn: string,
    entry: LdapUserEntry,
    policy: PpolicyConfig
  ): PasswordStatus {
    const now = Date.now();

    // Parse pwdChangedTime
    const lastChanged = this.parseGeneralizedTime(entry.pwdChangedTime);

    // Calculate expiration
    let expiresAt: Date | null = null;
    let isExpired = false;
    let daysUntilExpiration: number | null = null;

    if (policy.pwdMaxAge && lastChanged) {
      expiresAt = new Date(lastChanged.getTime() + policy.pwdMaxAge * 1000);
      isExpired = now > expiresAt.getTime();
      daysUntilExpiration = Math.ceil((expiresAt.getTime() - now) / 86400000);
    }

    // Check warning period
    let isExpiringSoon = false;
    const warnDays = (this.config.ppolicy_warn_days as number) || 14;
    if (daysUntilExpiration !== null && daysUntilExpiration > 0) {
      isExpiringSoon = daysUntilExpiration <= warnDays;
    }

    // Check lockout
    const lockedTime = entry.pwdAccountLockedTime;
    let isLocked = !!lockedTime;
    const isPermanentLock = lockedTime === '000001010000Z';

    // Calculate lockout end (auto-unlock if duration passed)
    if (isLocked && !isPermanentLock && policy.pwdLockoutDuration) {
      const lockedAt = this.parseGeneralizedTime(lockedTime);
      if (lockedAt) {
        const lockoutEndsAt = new Date(
          lockedAt.getTime() + policy.pwdLockoutDuration * 1000
        );
        if (now > lockoutEndsAt.getTime()) {
          isLocked = false;
        }
      }
    }

    // Count failures (pwdFailureTime is multi-valued GeneralizedTime)
    const failures: unknown = entry.pwdFailureTime;
    const failureCount = Array.isArray(failures) ? failures.length : 0;

    // Grace logins used (pwdGraceUseTime is multi-valued GeneralizedTime)
    const graceLogins: unknown = entry.pwdGraceUseTime;
    const graceLoginsUsed = Array.isArray(graceLogins) ? graceLogins.length : 0;

    // Must change password
    const mustChange = entry.pwdReset === 'TRUE';

    return {
      dn,
      passwordSet: !!entry.userPassword,
      lastChanged: lastChanged?.toISOString() || null,
      expiresAt: expiresAt?.toISOString() || null,
      daysUntilExpiration,
      isExpired,
      isExpiringSoon,
      mustChange,
      isLocked,
      lockedAt: lockedTime
        ? this.parseGeneralizedTime(lockedTime)?.toISOString() || null
        : null,
      failureCount,
      graceLoginsUsed,
    };
  }

  /**
   * Unlock a user account by removing pwdAccountLockedTime and pwdFailureTime
   */
  private async unlockAccount(userId: string): Promise<void> {
    const dn = this.resolveUserDn(userId);

    // First check if user exists
    const result = (await this.server.ldap.search(
      {
        filter: '(objectClass=*)',
        scope: 'base',
        attributes: ['pwdAccountLockedTime', 'pwdFailureTime'],
        paged: false,
      },
      dn
    )) as SearchResult;

    if (!result.searchEntries || result.searchEntries.length === 0) {
      throw new NotFoundError(`User not found: ${userId}`);
    }

    const entry = result.searchEntries[0] as LdapUserEntry;

    // Build delete changes for existing attributes only
    const deleteAttrs: Record<string, string[]> = {};
    if (entry.pwdAccountLockedTime) {
      deleteAttrs.pwdAccountLockedTime = [];
    }
    if (entry.pwdFailureTime) {
      deleteAttrs.pwdFailureTime = [];
    }

    if (Object.keys(deleteAttrs).length > 0) {
      await this.server.ldap.modify(dn, {
        delete: deleteAttrs,
      });
      this.logger.info(`Account unlocked: ${dn}`);
    } else {
      this.logger.info(`Account was not locked: ${dn}`);
    }
  }

  /**
   * Find users with passwords expiring soon
   */
  private async findExpiringPasswords(days: number): Promise<ExpiringUser[]> {
    const policy = await this.readPolicyConfig();

    // If no pwdMaxAge, passwords don't expire
    if (!policy.pwdMaxAge) {
      return [];
    }

    // Search users with pwdChangedTime
    const base =
      (this.config.ldap_users_base as string) ||
      (this.config.ldap_base as string);

    const result = (await this.server.ldap.search(
      {
        filter: '(pwdChangedTime=*)',
        scope: 'sub',
        attributes: ['uid', 'cn', 'displayName', 'mail', 'pwdChangedTime'],
        paged: false,
      },
      base
    )) as SearchResult;

    const now = Date.now();
    const warningMs = days * 24 * 60 * 60 * 1000;

    const expiringUsers: ExpiringUser[] = [];

    for (const entry of result.searchEntries) {
      const e = entry as LdapUserEntry;
      const changed = this.parseGeneralizedTime(e.pwdChangedTime);
      if (!changed) continue;

      const expiresAt = new Date(changed.getTime() + policy.pwdMaxAge * 1000);
      const remaining = expiresAt.getTime() - now;

      if (remaining > 0 && remaining < warningMs) {
        expiringUsers.push({
          dn: e.dn,
          uid: e.uid,
          displayName: e.displayName || e.cn,
          mail: e.mail,
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiration: Math.ceil(remaining / 86400000),
        });
      }
    }

    // Sort by expiration date (soonest first)
    return expiringUsers.sort(
      (a, b) => a.daysUntilExpiration - b.daysUntilExpiration
    );
  }

  /**
   * Find locked accounts
   */
  private async findLockedAccounts(): Promise<LockedAccount[]> {
    const base =
      (this.config.ldap_users_base as string) ||
      (this.config.ldap_base as string);

    const result = (await this.server.ldap.search(
      {
        filter: '(pwdAccountLockedTime=*)',
        scope: 'sub',
        attributes: [
          'uid',
          'cn',
          'displayName',
          'mail',
          'pwdAccountLockedTime',
          'pwdFailureTime',
        ],
        paged: false,
      },
      base
    )) as SearchResult;

    return result.searchEntries.map(entry => {
      const e = entry as LdapUserEntry;
      return {
        dn: e.dn,
        uid: e.uid,
        displayName: e.displayName || e.cn,
        mail: e.mail,
        lockedAt: this.parseGeneralizedTime(
          e.pwdAccountLockedTime
        )?.toISOString(),
        failureCount: Array.isArray(e.pwdFailureTime)
          ? e.pwdFailureTime.length
          : 0,
      };
    });
  }

  /**
   * Read ppolicy configuration from LDAP
   */
  private async readPolicyConfig(): Promise<PpolicyConfig> {
    // Check cache
    if (
      this.policyCache &&
      Date.now() - this.policyCacheTime < this.POLICY_CACHE_TTL
    ) {
      return this.policyCache;
    }

    const policyDn = this.config.ppolicy_default_dn as string;

    if (policyDn) {
      // Read specific policy DN
      try {
        const result = (await this.server.ldap.search(
          {
            filter: '(objectClass=*)',
            scope: 'base',
            attributes: PPOLICY_CONFIG_ATTRS,
            paged: false,
          },
          policyDn
        )) as SearchResult;

        if (result.searchEntries.length > 0) {
          this.policyCache = this.parsePolicyEntry(
            result.searchEntries[0] as LdapPolicyEntry,
            policyDn
          );
          this.policyCacheTime = Date.now();
          return this.policyCache;
        }
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        this.logger.warn(`Failed to read ppolicy from ${policyDn}: ${error}`);
      }
    }

    // Search for default ppolicy
    try {
      const result = (await this.server.ldap.search(
        {
          filter: '(objectClass=pwdPolicy)',
          scope: 'sub',
          attributes: PPOLICY_CONFIG_ATTRS,
          paged: false,
        },
        this.config.ldap_base as string
      )) as SearchResult;

      if (result.searchEntries.length > 0) {
        const entry = result.searchEntries[0] as LdapPolicyEntry;
        this.policyCache = this.parsePolicyEntry(entry, entry.dn);
        this.policyCacheTime = Date.now();
        return this.policyCache;
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`No ppolicy found: ${error}`);
    }

    // No policy found, return empty config
    this.policyCache = {};
    this.policyCacheTime = Date.now();
    return this.policyCache;
  }

  /**
   * Parse ppolicy entry to config object
   */
  private parsePolicyEntry(entry: LdapPolicyEntry, dn: string): PpolicyConfig {
    return {
      dn,
      pwdMaxAge: this.parseNumber(entry.pwdMaxAge),
      pwdMinAge: this.parseNumber(entry.pwdMinAge),
      pwdInHistory: this.parseNumber(entry.pwdInHistory),
      pwdCheckQuality: this.parseNumber(entry.pwdCheckQuality),
      pwdMinLength: this.parseNumber(entry.pwdMinLength),
      pwdMaxFailure: this.parseNumber(entry.pwdMaxFailure),
      pwdLockout: entry.pwdLockout === 'TRUE',
      pwdLockoutDuration: this.parseNumber(entry.pwdLockoutDuration),
      pwdGraceAuthNLimit: this.parseNumber(entry.pwdGraceAuthNLimit),
      pwdExpireWarning: this.parseNumber(entry.pwdExpireWarning),
      pwdMustChange: entry.pwdMustChange === 'TRUE',
      pwdAllowUserChange:
        entry.pwdAllowUserChange === undefined ||
        entry.pwdAllowUserChange === 'TRUE',
    };
  }

  /**
   * Parse number from LDAP attribute value
   */
  private parseNumber(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const num = parseInt(value, 10);
    return isNaN(num) ? undefined : num;
  }

  /**
   * Parse GeneralizedTime (YYYYMMDDHHmmssZ) to Date
   */
  private parseGeneralizedTime(value: string | undefined): Date | null {
    if (!value) return null;
    // Format: YYYYMMDDHHmmss[.fraction]Z
    const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!match) return null;
    const [, y, m, d, h, min, s] = match;
    return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
  }

  /**
   * Validate password complexity (optional local validation)
   */
  private validateComplexity(password: string): ValidationResult {
    const errors: string[] = [];
    const cfg = this.config;

    const minLength = (cfg.ppolicy_min_length as number) || 12;
    if (password.length < minLength) {
      errors.push(`Minimum ${minLength} characters required`);
    }

    if (cfg.ppolicy_require_uppercase && !/[A-Z]/.test(password)) {
      errors.push('At least one uppercase letter required');
    }

    if (cfg.ppolicy_require_lowercase && !/[a-z]/.test(password)) {
      errors.push('At least one lowercase letter required');
    }

    if (cfg.ppolicy_require_digit && !/\d/.test(password)) {
      errors.push('At least one digit required');
    }

    if (cfg.ppolicy_require_special && !SPECIAL_CHARS_REGEX.test(password)) {
      errors.push('At least one special character required');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Resolve user DN from userId (uid or full DN)
   * Escapes special characters in userId to prevent LDAP injection
   */
  private resolveUserDn(userId: string): string {
    if (userId.includes('=')) return userId; // Already a DN
    const base =
      (this.config.ldap_users_base as string) ||
      (this.config.ldap_base as string);
    const attr = (this.config.ldap_user_main_attribute as string) || 'uid';
    return `${attr}=${escapeDnValue(userId)},${base}`;
  }

  /**
   * Provide configuration data for config API
   */
  getConfigApiData(): Record<string, unknown> | undefined {
    const apiPrefix = this.config.api_prefix || '/api';
    const validateComplexity = !!this.config.ppolicy_validate_complexity;

    return {
      name: this.name,
      enabled: true,
      endpoints: {
        getPolicy: `${apiPrefix}/v1/password-policy`,
        getUserStatus: `${apiPrefix}/v1/users/:id/password-status`,
        unlockUser: `${apiPrefix}/v1/users/:id/unlock`,
        getExpiringSoon: `${apiPrefix}/v1/password-policy/expiring-soon`,
        getLockedAccounts: `${apiPrefix}/v1/password-policy/locked-accounts`,
        validatePassword: validateComplexity
          ? `${apiPrefix}/v1/password/validate`
          : undefined,
      },
      config: {
        warnDays: this.config.ppolicy_warn_days || 14,
        validateComplexity,
        // Include complexity rules when validation is enabled
        ...(validateComplexity && {
          complexityRules: {
            minLength: this.config.ppolicy_min_length || 12,
            requireUppercase: this.config.ppolicy_require_uppercase ?? true,
            requireLowercase: this.config.ppolicy_require_lowercase ?? true,
            requireDigit: this.config.ppolicy_require_digit ?? true,
            requireSpecial: this.config.ppolicy_require_special ?? true,
          },
        }),
      },
      // Include cached LDAP ppolicy if available
      ldapPolicy: this.policyCache || undefined,
    };
  }
}
