/**
 * Password Policy plugin - Administration API for OpenLDAP ppolicy
 *
 * Provides REST endpoints to:
 * - Query password status (expiration, lockout, etc.)
 * - Unlock locked accounts
 * - List expiring passwords and locked accounts
 * - List, create, edit, delete and assign password policies
 * - Validate password complexity (optional)
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { isDeepStrictEqual } from 'node:util';

import type { Express, Request, Response } from 'express';

import DmPlugin, {
  type Role,
  asyncHandler,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../../abstract/plugin';
import type { ModifyRequest, SearchResult } from '../../lib/ldapActions';
import {
  escapeDnValue,
  escapeLdapFilter,
  normalizeDn,
  validateDnValue,
} from '../../lib/utils';
import { jsonBody } from '../../lib/expressFormatedResponses';
import { extractLdapCode } from '../../lib/ldapCodes';

// ppolicy operational attributes to read
const PPOLICY_ATTRS = [
  'pwdChangedTime',
  'pwdAccountLockedTime',
  'pwdFailureTime',
  'pwdGraceUseTime',
  'pwdReset',
  'pwdPolicySubentry',
];

// Policy attributes the API writes, by value type
const POLICY_ATTRIBUTE_TYPES: Record<string, 'integer' | 'boolean' | 'text'> = {
  pwdMinAge: 'integer',
  pwdMaxAge: 'integer',
  pwdInHistory: 'integer',
  pwdCheckQuality: 'integer',
  pwdMinLength: 'integer',
  pwdMaxLength: 'integer',
  pwdExpireWarning: 'integer',
  pwdGraceAuthNLimit: 'integer',
  pwdGraceExpiry: 'integer',
  pwdLockout: 'boolean',
  pwdLockoutDuration: 'integer',
  pwdMaxFailure: 'integer',
  pwdFailureCountInterval: 'integer',
  pwdMustChange: 'boolean',
  pwdAllowUserChange: 'boolean',
  pwdSafeModify: 'boolean',
  pwdMinDelay: 'integer',
  pwdMaxDelay: 'integer',
  pwdMaxIdle: 'integer',
  pwdMaxRecordedFailure: 'integer',
  pwdCheckModuleArg: 'text',
  pwdUseCheckModule: 'boolean',
};

// Served, never written: before OpenLDAP 2.6, pwdCheckModule is the path of
// a shared object slapd loads, so writing it would run code in slapd
const READ_ONLY_POLICY_ATTRS = ['pwdAttribute', 'pwdCheckModule'];

// Carried by the pwdPolicyChecker class, not by pwdPolicy
const CHECKER_ATTRS = ['pwdCheckModuleArg', 'pwdUseCheckModule'];

const ALL_POLICY_ATTRS = [
  ...Object.keys(POLICY_ATTRIBUTE_TYPES),
  ...READ_ONLY_POLICY_ATTRS,
];

const isWritablePolicyAttribute = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(POLICY_ATTRIBUTE_TYPES, name);

type RawEntry = Record<string, unknown> & { dn: string };

// The values of an attribute as the driver returns it, none when absent
const values = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map(v => (Buffer.isBuffer(v) ? v.toString() : String(v)))
    .filter(v => v !== '');

const first = (value: unknown): string | undefined => values(value)[0];

// Read through these, an attribute asked for and absent, which ldapts
// answers as an empty list, is undefined
const userEntry = (raw: RawEntry): LdapUserEntry => ({
  dn: raw.dn,
  userPassword: first(raw.userPassword),
  uid: first(raw.uid),
  cn: first(raw.cn),
  displayName: first(raw.displayName),
  mail: first(raw.mail),
  pwdChangedTime: first(raw.pwdChangedTime),
  pwdAccountLockedTime: first(raw.pwdAccountLockedTime),
  pwdFailureTime: values(raw.pwdFailureTime),
  pwdGraceUseTime: values(raw.pwdGraceUseTime),
  pwdReset: first(raw.pwdReset),
  pwdPolicySubentry: first(raw.pwdPolicySubentry),
});

// The policy attributes an entry holds, typed
const typedPolicy = (raw: RawEntry): Record<string, unknown> => {
  const typed: Record<string, unknown> = {};
  for (const name of ALL_POLICY_ATTRS) {
    const found = values(raw[name]);
    if (found.length === 0) continue;
    switch (POLICY_ATTRIBUTE_TYPES[name]) {
      case 'integer': {
        const num = parseInt(found[0], 10);
        if (!isNaN(num)) typed[name] = num;
        break;
      }
      case 'boolean':
        typed[name] = found[0] === 'TRUE';
        break;
      default:
        typed[name] = found.length === 1 ? found[0] : found;
    }
  }
  return typed;
};

// The shape GET /password-policy serves, absent booleans read as ppolicy's
// defaults
const policyConfig = (raw: RawEntry, dn: string): PpolicyConfig => {
  const typed = typedPolicy(raw);
  return {
    dn,
    pwdMaxAge: typed.pwdMaxAge as number | undefined,
    pwdMinAge: typed.pwdMinAge as number | undefined,
    pwdInHistory: typed.pwdInHistory as number | undefined,
    pwdCheckQuality: typed.pwdCheckQuality as number | undefined,
    pwdMinLength: typed.pwdMinLength as number | undefined,
    pwdMaxFailure: typed.pwdMaxFailure as number | undefined,
    pwdLockout: typed.pwdLockout === true,
    pwdLockoutDuration: typed.pwdLockoutDuration as number | undefined,
    pwdGraceAuthNLimit: typed.pwdGraceAuthNLimit as number | undefined,
    pwdExpireWarning: typed.pwdExpireWarning as number | undefined,
    pwdMustChange: typed.pwdMustChange === true,
    pwdAllowUserChange: typed.pwdAllowUserChange !== false,
  };
};

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
  policy: string | null;
}

/** A password policy entry as the management routes serve it */
type PolicyRecord = Record<string, unknown> & {
  dn: string;
  cn: string;
  isDefault: boolean;
};

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

/**
 * Shared OpenAPI schemas surfaced by this plugin. Picked up by
 * scripts/generate-openapi.ts and merged into `components.schemas`.
 *
 * @openapi-component
 * PasswordPolicy:
 *   type: object
 *   description: |
 *     Active OpenLDAP ppolicy configuration. All duration fields are in
 *     **seconds**. Absent fields mean the policy attribute is not set.
 *   properties:
 *     dn:
 *       type: string
 *       description: DN of the ppolicy entry.
 *       example: cn=default,ou=policies,dc=example,dc=com
 *     pwdMaxAge:
 *       type: integer
 *       description: Maximum password age in seconds (0 = never expires).
 *       example: 7776000
 *     pwdMinAge:
 *       type: integer
 *       description: Minimum password age in seconds before it may be changed.
 *       example: 0
 *     pwdInHistory:
 *       type: integer
 *       description: Number of previous passwords stored.
 *       example: 5
 *     pwdCheckQuality:
 *       type: integer
 *       description: Password quality enforcement level (0-2).
 *       example: 1
 *     pwdMinLength:
 *       type: integer
 *       description: Minimum password length.
 *       example: 12
 *     pwdMaxFailure:
 *       type: integer
 *       description: Maximum bind failures before lockout.
 *       example: 5
 *     pwdLockout:
 *       type: boolean
 *       description: Whether account lockout is enabled.
 *       example: true
 *     pwdLockoutDuration:
 *       type: integer
 *       description: Lockout duration in seconds (0 = permanent until admin reset).
 *       example: 300
 *     pwdGraceAuthNLimit:
 *       type: integer
 *       description: Number of grace logins allowed after password expires.
 *       example: 0
 *     pwdExpireWarning:
 *       type: integer
 *       description: Seconds before expiry at which a warning is issued.
 *       example: 1209600
 *     pwdMustChange:
 *       type: boolean
 *       description: If true, users must change their password after an admin reset.
 *       example: true
 *     pwdAllowUserChange:
 *       type: boolean
 *       description: Whether users are allowed to change their own password.
 *       example: true
 * PasswordStatus:
 *   type: object
 *   description: Current password status for a specific user account.
 *   required: [dn, passwordSet, isExpired, isExpiringSoon, mustChange, isLocked, failureCount, graceLoginsUsed]
 *   properties:
 *     dn:
 *       type: string
 *       description: Fully-qualified DN of the user.
 *       example: uid=alice,ou=users,dc=example,dc=com
 *     passwordSet:
 *       type: boolean
 *       description: Whether a userPassword attribute is present.
 *       example: true
 *     lastChanged:
 *       type: string
 *       format: date-time
 *       nullable: true
 *       description: ISO-8601 timestamp of last password change, or null if never set.
 *       example: '2026-01-15T10:00:00.000Z'
 *     expiresAt:
 *       type: string
 *       format: date-time
 *       nullable: true
 *       description: ISO-8601 expiry timestamp, or null if no max age is configured.
 *       example: '2026-04-15T10:00:00.000Z'
 *     daysUntilExpiration:
 *       type: integer
 *       nullable: true
 *       description: Remaining days until expiry (negative means already expired).
 *       example: 80
 *     isExpired:
 *       type: boolean
 *       example: false
 *     isExpiringSoon:
 *       type: boolean
 *       description: True when expiry is within the configured warning window.
 *       example: false
 *     mustChange:
 *       type: boolean
 *       description: True when `pwdReset` is set (admin forced change).
 *       example: false
 *     isLocked:
 *       type: boolean
 *       description: True when the account is currently locked.
 *       example: false
 *     lockedAt:
 *       type: string
 *       format: date-time
 *       nullable: true
 *       description: ISO-8601 timestamp of lockout, or null.
 *       example: null
 *     failureCount:
 *       type: integer
 *       description: Number of recorded bind failures still within the window.
 *       example: 0
 *     graceLoginsUsed:
 *       type: integer
 *       description: Number of grace logins already consumed.
 *       example: 0
 *     policy:
 *       type: string
 *       nullable: true
 *       description: |
 *         DN of the policy the status was computed with: the one the
 *         account's `pwdPolicySubentry` names, else the default one.
 *       example: cn=default,ou=policies,dc=example,dc=com
 * PasswordPolicyEntry:
 *   type: object
 *   description: |
 *     A password policy entry. Only the attributes the entry holds are
 *     served; durations are in **seconds**. `pwdAttribute` and
 *     `pwdCheckModule` are read-only.
 *   required: [dn, cn, isDefault]
 *   properties:
 *     dn: { type: string, example: 'cn=default,ou=policies,dc=example,dc=com' }
 *     cn: { type: string, example: default }
 *     isDefault:
 *       type: boolean
 *       description: Whether this is the policy accounts without `pwdPolicySubentry` get.
 *     pwdAttribute: { type: string, example: userPassword }
 *     pwdMinAge: { type: integer }
 *     pwdMaxAge: { type: integer, example: 7776000 }
 *     pwdInHistory: { type: integer, example: 5 }
 *     pwdCheckQuality: { type: integer, minimum: 0, maximum: 2 }
 *     pwdMinLength: { type: integer, example: 12 }
 *     pwdMaxLength: { type: integer }
 *     pwdExpireWarning: { type: integer }
 *     pwdGraceAuthNLimit: { type: integer }
 *     pwdGraceExpiry: { type: integer }
 *     pwdLockout: { type: boolean }
 *     pwdLockoutDuration: { type: integer }
 *     pwdMaxFailure: { type: integer }
 *     pwdFailureCountInterval: { type: integer }
 *     pwdMustChange: { type: boolean }
 *     pwdAllowUserChange: { type: boolean }
 *     pwdSafeModify: { type: boolean }
 *     pwdMinDelay: { type: integer }
 *     pwdMaxDelay: { type: integer }
 *     pwdMaxIdle: { type: integer }
 *     pwdMaxRecordedFailure: { type: integer }
 *     pwdCheckModule: { type: string }
 *     pwdCheckModuleArg:
 *       type: string
 *       description: Configuration of the quality-check module, usually several lines.
 *     pwdUseCheckModule: { type: boolean }
 * PasswordPolicyChanges:
 *   type: object
 *   description: |
 *     Attributes to set, by name as in `PasswordPolicyEntry`. `null` removes
 *     the attribute. On `PATCH`, `dn`, `cn`, `isDefault` and the read-only
 *     attributes are accepted only with the value the entry already has.
 *   additionalProperties: true
 *   example: { pwdMaxAge: 31536000, pwdLockout: true, pwdExpireWarning: null }
 * ExpiringAccount:
 *   type: object
 *   description: User whose password is expiring within the warning window.
 *   required: [dn, expiresAt, daysUntilExpiration]
 *   properties:
 *     dn: { type: string, example: uid=bob,ou=users,dc=example,dc=com }
 *     uid: { type: string, example: bob }
 *     displayName: { type: string, example: Bob Builder }
 *     mail: { type: string, example: bob@example.com }
 *     expiresAt:
 *       type: string
 *       format: date-time
 *       example: '2026-05-01T08:00:00.000Z'
 *     daysUntilExpiration: { type: integer, example: 6 }
 * LockedAccount:
 *   type: object
 *   description: User account that is currently locked.
 *   required: [dn, failureCount]
 *   properties:
 *     dn: { type: string, example: uid=charlie,ou=users,dc=example,dc=com }
 *     uid: { type: string, example: charlie }
 *     displayName: { type: string, example: Charlie Chaplin }
 *     mail: { type: string, example: charlie@example.com }
 *     lockedAt:
 *       type: string
 *       format: date-time
 *       nullable: true
 *       example: '2026-04-24T14:30:00.000Z'
 *     failureCount: { type: integer, example: 5 }
 * PasswordValidationRequest:
 *   type: object
 *   required: [password]
 *   properties:
 *     password:
 *       type: string
 *       format: password
 *       description: The candidate password to validate.
 *       example: 'S3cur3P@ss!'
 *     dn:
 *       type: string
 *       description: Optional user DN for context (not used in local validation).
 *       example: uid=alice,ou=users,dc=example,dc=com
 * PasswordValidationResponse:
 *   type: object
 *   required: [valid, errors]
 *   properties:
 *     valid:
 *       type: boolean
 *       description: True when the password meets all complexity rules.
 *       example: true
 *     errors:
 *       type: array
 *       items: { type: string }
 *       description: List of failed rule descriptions (empty when valid).
 *       example: []
 */
export default class PasswordPolicy extends DmPlugin {
  name = 'ldapPasswordPolicy';
  roles: Role[] = ['api', 'configurable'];

  // By normalized DN; null for a DN that holds no policy
  private policyCache = new Map<
    string,
    { policy: PpolicyConfig | null; time: number }
  >();
  private discoveredDefault: { dn: string | null; time: number } | null = null;
  private warnedAmbiguousDefault = false;
  private warnedMissingBase = false;
  private lastDefaultPolicy: PpolicyConfig | undefined;
  private readonly POLICY_CACHE_TTL = 60000; // 1 minute

  api(app: Express): void {
    const prefix = `${this.config.api_prefix}/v1`;

    /**
     * @openapi
     * summary: Get password policy
     * description: |
     *   Returns the active OpenLDAP ppolicy configuration read from the DN
     *   configured via `--ppolicy-default-dn`, or discovered by searching for
     *   `objectClass=pwdPolicy` when that option is absent.
     *   Results are cached for 60 seconds.
     * responses:
     *   '200':
     *     description: Active password policy.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/PasswordPolicy' }
     *         example:
     *           dn: cn=default,ou=policies,dc=example,dc=com
     *           pwdMinLength: 12
     *           pwdMaxAge: 7776000
     *           pwdMaxFailure: 5
     *           pwdLockout: true
     *           pwdLockoutDuration: 300
     *           pwdMustChange: true
     *           pwdAllowUserChange: true
     *           pwdInHistory: 5
     *           pwdGraceAuthNLimit: 0
     *   '403':
     *     description: An authorization plugin keeps the policies from the caller.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // GET /password-policy - configuration
    app.get(
      `${prefix}/password-policy`,
      asyncHandler(async (req: Request, res: Response) => {
        const policy = await this.readPolicyConfig();
        // Read through this plugin's cache: asked again as the caller, whom
        // an authorization plugin may keep from the policies
        if (policy.dn)
          await this.server.ldap.search(
            {
              filter: '(objectClass=*)',
              scope: 'base',
              attributes: ['1.1'],
              paged: false,
            },
            policy.dn,
            req
          );
        res.json(policy);
      })
    );

    /**
     * @openapi
     * summary: Get user password status
     * description: |
     *   Returns the current password state for user `:id`. The `id` may be
     *   a plain `uid` value or a full DN. The response is computed from the
     *   user's ppolicy operational attributes combined with the active policy.
     * responses:
     *   '200':
     *     description: Password status for the user.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/PasswordStatus' }
     *         example:
     *           dn: uid=alice,ou=users,dc=example,dc=com
     *           passwordSet: true
     *           lastChanged: '2026-01-15T10:00:00.000Z'
     *           expiresAt: '2026-04-15T10:00:00.000Z'
     *           daysUntilExpiration: 80
     *           isExpired: false
     *           isExpiringSoon: false
     *           mustChange: false
     *           isLocked: false
     *           lockedAt: null
     *           failureCount: 0
     *           graceLoginsUsed: 0
     *           policy: cn=default,ou=policies,dc=example,dc=com
     *   '404':
     *     description: User not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // GET /users/:id/password-status
    app.get(
      `${prefix}/users/:id/password-status`,
      asyncHandler(async (req: Request, res: Response) => {
        const userId = this.param(req, 'id');
        const status = await this.getPasswordStatus(userId, req);
        res.json(status);
      })
    );

    /**
     * @openapi
     * summary: Unlock user account
     * description: |
     *   Removes the `pwdAccountLockedTime` and `pwdFailureTime` operational
     *   attributes from the user entry, effectively clearing the lockout state.
     *   If the account was not locked the operation still succeeds (idempotent).
     * responses:
     *   '200':
     *     description: Account unlocked (or was already unlocked).
     *     content:
     *       application/json:
     *         example: { success: true, message: Account unlocked }
     *   '404':
     *     description: User not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // POST /users/:id/unlock
    app.post(
      `${prefix}/users/:id/unlock`,
      asyncHandler(async (req: Request, res: Response) => {
        const userId = this.param(req, 'id');
        await this.unlockAccount(userId, req);
        res.json({ success: true, message: 'Account unlocked' });
      })
    );

    /**
     * @openapi
     * summary: List accounts with expiring passwords
     * description: |
     *   Scans the user base for accounts whose password will expire within
     *   `days` days. Results are sorted ascending by `daysUntilExpiration`.
     *   Each account is judged by its own policy (`pwdPolicySubentry`, else
     *   the default one); those whose policy sets no `pwdMaxAge` never appear.
     * parameters:
     *   - in: query
     *     name: days
     *     schema: { type: integer, default: 14 }
     *     description: Warning window in days (defaults to `--ppolicy-warn-days` or 14).
     *     example: 7
     * responses:
     *   '200':
     *     description: List of expiring accounts with their warning window.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             warningDays: { type: integer, example: 7 }
     *             users:
     *               type: array
     *               items: { $ref: '#/components/schemas/ExpiringAccount' }
     *         example:
     *           warningDays: 7
     *           users:
     *             - dn: uid=bob,ou=users,dc=example,dc=com
     *               uid: bob
     *               displayName: Bob Builder
     *               mail: bob@example.com
     *               expiresAt: '2026-05-01T08:00:00.000Z'
     *               daysUntilExpiration: 6
     */
    // GET /password-policy/expiring-soon
    app.get(
      `${prefix}/password-policy/expiring-soon`,
      asyncHandler(async (req: Request, res: Response) => {
        const days =
          parseInt(req.query.days as string) ||
          (this.config.ppolicy_warn_days as number) ||
          14;
        const users = await this.findExpiringPasswords(days, req);
        res.json({ warningDays: days, users });
      })
    );

    /**
     * @openapi
     * summary: List locked accounts
     * description: |
     *   Returns all user entries in the user base that have a
     *   `pwdAccountLockedTime` attribute set, regardless of whether the
     *   lockout has expired. Use the `/unlock` endpoint to clear individual
     *   lockouts.
     * responses:
     *   '200':
     *     description: List of locked accounts.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             accounts:
     *               type: array
     *               items: { $ref: '#/components/schemas/LockedAccount' }
     *         example:
     *           accounts:
     *             - dn: uid=charlie,ou=users,dc=example,dc=com
     *               uid: charlie
     *               displayName: Charlie Chaplin
     *               mail: charlie@example.com
     *               lockedAt: '2026-04-24T14:30:00.000Z'
     *               failureCount: 5
     */
    // GET /password-policy/locked-accounts
    app.get(
      `${prefix}/password-policy/locked-accounts`,
      asyncHandler(async (req: Request, res: Response) => {
        const accounts = await this.findLockedAccounts(req);
        res.json({ accounts });
      })
    );

    /**
     * @openapi
     * summary: List password policies
     * description: |
     *   Returns every `pwdPolicy` entry under `--ppolicy-base` (else
     *   `--ldap-base`), sorted by `cn`.
     * responses:
     *   '200':
     *     description: The password policies.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             policies:
     *               type: array
     *               items: { $ref: '#/components/schemas/PasswordPolicyEntry' }
     */
    app.get(
      `${prefix}/password-policies`,
      asyncHandler(async (req: Request, res: Response) => {
        res.json({ policies: await this.listPolicies(req) });
      })
    );

    /**
     * @openapi
     * summary: Create a password policy
     * description: |
     *   Creates `cn=<cn>` under `--ppolicy-base` (else `--ldap-base`), applied
     *   to `userPassword`. The body holds `cn` and the attributes to set.
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         allOf:
     *           - $ref: '#/components/schemas/PasswordPolicyChanges'
     *           - type: object
     *             required: [cn]
     *             properties:
     *               cn: { type: string, example: software }
     * responses:
     *   '201':
     *     description: The policy created.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/PasswordPolicyEntry' }
     *   '400':
     *     description: Missing `cn`, unknown attribute or wrongly typed value.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: '`--ppolicy-base` does not exist.'
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '409':
     *     description: A policy of that name exists.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.post(
      `${prefix}/password-policies`,
      asyncHandler(async (req: Request, res: Response) => {
        const body = jsonBody(req, res);
        if (!body) return;
        const policy = await this.createPolicy(
          body as Record<string, unknown>,
          req
        );
        res.status(201).json(policy);
      })
    );

    /**
     * @openapi
     * summary: Get a password policy
     * responses:
     *   '200':
     *     description: The policy.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/PasswordPolicyEntry' }
     *   '404':
     *     description: No policy of that name.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${prefix}/password-policies/:cn`,
      asyncHandler(async (req: Request, res: Response) => {
        const entry = await this.findPolicy(this.param(req, 'cn'), req);
        res.json(await this.toPolicyRecord(entry));
      })
    );

    /**
     * @openapi
     * summary: Change a password policy
     * description: |
     *   Sets the attributes the body names and removes those given `null`.
     *   Writing `pwdCheckModuleArg` or `pwdUseCheckModule` gives the entry
     *   the `pwdPolicyChecker` class when it lacks it.
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/PasswordPolicyChanges' }
     * responses:
     *   '200':
     *     description: The policy as changed.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/PasswordPolicyEntry' }
     *   '400':
     *     description: Unknown or read-only attribute, or wrongly typed value.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: No policy of that name.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.patch(
      `${prefix}/password-policies/:cn`,
      asyncHandler(async (req: Request, res: Response) => {
        const body = jsonBody(req, res);
        if (!body) return;
        const policy = await this.updatePolicy(
          this.param(req, 'cn'),
          body as Record<string, unknown>,
          req
        );
        res.json(policy);
      })
    );

    /**
     * @openapi
     * summary: Delete a password policy
     * description: |
     *   Refused while the policy is the default one or an entry's
     *   `pwdPolicySubentry` names it.
     * responses:
     *   '200':
     *     description: Policy deleted.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '404':
     *     description: No policy of that name.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '409':
     *     description: The policy is the default one, or is still applied.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.delete(
      `${prefix}/password-policies/:cn`,
      asyncHandler(async (req: Request, res: Response) => {
        await this.deletePolicy(this.param(req, 'cn'), req);
        res.json({ success: true });
      })
    );

    /**
     * @openapi
     * summary: Assign a password policy to an account
     * description: |
     *   Sets the account's `pwdPolicySubentry` to the policy named `policy`,
     *   or removes it when `policy` is `null`, the account then getting the
     *   default policy. The `id` may be a plain `uid` value or a full DN.
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         type: object
     *         required: [policy]
     *         properties:
     *           policy: { type: string, nullable: true, example: software }
     * responses:
     *   '200':
     *     description: The policy now applied.
     *     content:
     *       application/json:
     *         example:
     *           dn: uid=build,ou=users,dc=example,dc=com
     *           policy: cn=software,ou=policies,dc=example,dc=com
     *   '400':
     *     description: Missing `policy`.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: No such account, or no policy of that name.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.put(
      `${prefix}/users/:id/password-policy`,
      asyncHandler(async (req: Request, res: Response) => {
        const body = jsonBody(req, res);
        if (!body) return;
        const { policy } = body as { policy?: unknown };
        if (policy !== null && (typeof policy !== 'string' || !policy))
          throw new BadRequestError('policy must be a policy name or null');
        res.json(await this.assignPolicy(this.param(req, 'id'), policy, req));
      })
    );

    // POST /password/validate (optional)
    if (this.config.ppolicy_validate_complexity) {
      /**
       * @openapi
       * summary: Validate password complexity
       * description: |
       *   Validates a candidate password against the locally-configured complexity
       *   rules (`--ppolicy-min-length`, `--ppolicy-require-uppercase`, etc.).
       *   This endpoint is only registered when `--ppolicy-validate-complexity` is
       *   enabled. It does **not** call LDAP — it runs a local rule check only.
       * requestBody:
       *   required: true
       *   content:
       *     application/json:
       *       schema: { $ref: '#/components/schemas/PasswordValidationRequest' }
       * responses:
       *   '200':
       *     description: Validation result.
       *     content:
       *       application/json:
       *         schema: { $ref: '#/components/schemas/PasswordValidationResponse' }
       *         example:
       *           valid: false
       *           errors:
       *             - Minimum 12 characters required
       *             - At least one special character required
       *   '400':
       *     description: Missing `password` field.
       *     content:
       *       application/json:
       *         schema: { $ref: '#/components/schemas/Error' }
       */
      app.post(
        `${prefix}/password/validate`,
        // eslint-disable-next-line @typescript-eslint/require-await
        asyncHandler(async (req: Request, res: Response) => {
          const body = jsonBody(req, res);
          if (!body) return;
          const { password } = body as { password?: string };
          if (!password) throw new BadRequestError('password required');
          const result = this.validateComplexity(password);
          res.json(result);
        })
      );
    }
  }

  /**
   * Get password status for a user
   *
   * Every account lookup and write carries the request, so an authorization
   * plugin answers for the caller: without it, a route read as an internal
   * call, and a delegated administrator could read or unlock any account of
   * the directory (#325).
   */
  private async getPasswordStatus(
    userId: string,
    req?: Request
  ): Promise<PasswordStatus> {
    const dn = this.resolveUserDn(userId);
    const entry = await this.readUser(dn, userId, ['*', ...PPOLICY_ATTRS], req);
    const policy = await this.policyFor(entry);
    return this.calculateStatus(dn, entry, policy);
  }

  private async readUser(
    dn: string,
    userId: string,
    attributes: string[],
    req?: Request
  ): Promise<LdapUserEntry> {
    try {
      const result = (await this.server.ldap.search(
        {
          filter: '(objectClass=*)',
          scope: 'base',
          attributes,
          paged: false,
        },
        dn,
        req
      )) as SearchResult;

      if (!result.searchEntries || result.searchEntries.length === 0) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      return userEntry(result.searchEntries[0] as RawEntry);
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
      policy: policy.dn ?? null,
    };
  }

  /**
   * Unlock a user account by removing pwdAccountLockedTime and pwdFailureTime
   */
  private async unlockAccount(userId: string, req?: Request): Promise<void> {
    const dn = this.resolveUserDn(userId);

    // First check if user exists
    const result = (await this.server.ldap.search(
      {
        filter: '(objectClass=*)',
        scope: 'base',
        attributes: ['pwdAccountLockedTime', 'pwdFailureTime'],
        paged: false,
      },
      dn,
      req
    )) as SearchResult;

    if (!result.searchEntries || result.searchEntries.length === 0) {
      throw new NotFoundError(`User not found: ${userId}`);
    }

    const entry = userEntry(result.searchEntries[0] as RawEntry);

    // Build delete changes for existing attributes only
    const deleteAttrs: Record<string, string[]> = {};
    if (entry.pwdAccountLockedTime) {
      deleteAttrs.pwdAccountLockedTime = [];
    }
    if (entry.pwdFailureTime?.length) {
      deleteAttrs.pwdFailureTime = [];
    }

    if (Object.keys(deleteAttrs).length > 0) {
      await this.server.ldap.modify(
        dn,
        {
          delete: deleteAttrs,
        },
        req
      );
      this.logger.info(`Account unlocked: ${dn}`);
    } else {
      this.logger.info(`Account was not locked: ${dn}`);
    }
  }

  /**
   * Find users with passwords expiring soon
   */
  private async findExpiringPasswords(
    days: number,
    req?: Request
  ): Promise<ExpiringUser[]> {
    // Search users with pwdChangedTime
    const base =
      (this.config.ldap_users_base as string) ||
      (this.config.ldap_base as string);

    const result = (await this.server.ldap.search(
      {
        filter: '(pwdChangedTime=*)',
        scope: 'sub',
        attributes: [
          'uid',
          'cn',
          'displayName',
          'mail',
          'pwdChangedTime',
          'pwdPolicySubentry',
        ],
        paged: false,
      },
      base,
      req
    )) as SearchResult;

    const now = Date.now();
    const warningMs = days * 24 * 60 * 60 * 1000;

    const expiringUsers: ExpiringUser[] = [];

    for (const entry of result.searchEntries) {
      const e = userEntry(entry as RawEntry);
      const changed = this.parseGeneralizedTime(e.pwdChangedTime);
      if (!changed) continue;
      const policy = await this.policyFor(e);
      // Without pwdMaxAge, the password does not expire
      if (!policy.pwdMaxAge) continue;

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
  private async findLockedAccounts(req?: Request): Promise<LockedAccount[]> {
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
      base,
      req
    )) as SearchResult;

    return result.searchEntries.map(entry => {
      const e = userEntry(entry as RawEntry);
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
   * The policy the overlay applies to an entry: the one its
   * pwdPolicySubentry names, else the default one, which slapd also falls
   * back to when the named entry holds no policy
   */
  private async policyFor(entry: LdapUserEntry): Promise<PpolicyConfig> {
    if (entry.pwdPolicySubentry) {
      const policy = await this.readPolicyAt(entry.pwdPolicySubentry);
      if (policy) return policy;
    }
    return this.readPolicyConfig();
  }

  /**
   * Read the default ppolicy: --ppolicy-default-dn, else the only policy
   * under the policy base
   */
  private async readPolicyConfig(): Promise<PpolicyConfig> {
    const dn =
      (this.config.ppolicy_default_dn as string) ||
      (await this.discoverDefaultDn());
    const policy = dn ? await this.readPolicyAt(dn) : null;
    this.lastDefaultPolicy = policy ?? {};
    return this.lastDefaultPolicy;
  }

  /**
   * With several policies, the default one is named in slapd's
   * configuration (olcPPolicyDefault), which this server cannot read
   */
  private async discoverDefaultDn(): Promise<string | null> {
    if (
      this.discoveredDefault &&
      Date.now() - this.discoveredDefault.time < this.POLICY_CACHE_TTL
    ) {
      return this.discoveredDefault.dn;
    }
    let dn: string | null = null;
    try {
      const result = (await this.server.ldap.search(
        {
          filter: '(objectClass=pwdPolicy)',
          scope: 'sub',
          attributes: ['1.1'],
          paged: false,
        },
        this.policyBase()
      )) as SearchResult;
      const found = result.searchEntries.map(entry => entry.dn);
      if (found.length === 1) {
        dn = found[0];
      } else if (found.length > 1 && !this.warnedAmbiguousDefault) {
        this.warnedAmbiguousDefault = true;
        this.logger.warn(
          `${found.length} password policies found and no --ppolicy-default-dn: ` +
            'accounts without pwdPolicySubentry are reported without a policy'
        );
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`No ppolicy found: ${error}`);
    }
    this.discoveredDefault = { dn, time: Date.now() };
    return dn;
  }

  /**
   * Read the policy at `dn`, null when it holds none
   */
  private async readPolicyAt(dn: string): Promise<PpolicyConfig | null> {
    const key = normalizeDn(dn);
    const cached = this.policyCache.get(key);
    if (cached && Date.now() - cached.time < this.POLICY_CACHE_TTL) {
      return cached.policy;
    }
    let policy: PpolicyConfig | null = null;
    let failure: string | undefined;
    try {
      const result = (await this.server.ldap.search(
        {
          filter: '(objectClass=pwdPolicy)',
          scope: 'base',
          attributes: ALL_POLICY_ATTRS,
          paged: false,
        },
        dn
      )) as SearchResult;
      if (result.searchEntries.length > 0) {
        policy = policyConfig(result.searchEntries[0] as RawEntry, dn);
      }
    } catch (error) {
      failure = String(error);
    }
    // A dangling pwdPolicySubentry is the account's business; a default
    // policy that cannot be read is a configuration error
    const configured = this.config.ppolicy_default_dn as string;
    if (!policy && configured && normalizeDn(configured) === key) {
      this.logger.warn(
        `--ppolicy-default-dn ${dn} holds no password policy${failure ? `: ${failure}` : ''}`
      );
    } else if (failure) {
      this.logger.debug(`Failed to read ppolicy from ${dn}: ${failure}`);
    }
    this.policyCache.set(key, { policy, time: Date.now() });
    return policy;
  }

  private forgetPolicies(): void {
    this.policyCache.clear();
    this.discoveredDefault = null;
  }

  private policyBase(): string {
    return (
      (this.config.ppolicy_base as string) || (this.config.ldap_base as string)
    );
  }

  /**
   * The policy entries under the policy base matching `filter`, none when
   * the base itself is missing
   */
  private async searchPolicies(
    filter: string,
    req?: Request
  ): Promise<RawEntry[]> {
    try {
      const result = (await this.server.ldap.search(
        {
          filter: `(&(objectClass=pwdPolicy)${filter})`,
          scope: 'sub',
          attributes: ['objectClass', 'cn', ...ALL_POLICY_ATTRS],
          paged: false,
        },
        this.policyBase(),
        req
      )) as SearchResult;
      return result.searchEntries as RawEntry[];
    } catch (error) {
      if (extractLdapCode(error) !== 32) throw error;
      if (!this.warnedMissingBase) {
        this.warnedMissingBase = true;
        this.logger.warn(
          `${this.policyBase()} does not exist: no password policy is found there, check --ppolicy-base`
        );
      }
      return [];
    }
  }

  /**
   * The policy named `cn` under the policy base
   */
  private async findPolicy(cn: string, req?: Request): Promise<RawEntry> {
    const found = await this.searchPolicies(
      `(cn=${escapeLdapFilter(cn)})`,
      req
    );
    if (found.length === 0) {
      throw new NotFoundError(`No password policy named ${cn}`);
    }
    if (found.length > 1) {
      throw new ConflictError(`Several password policies are named ${cn}`);
    }
    return found[0];
  }

  private async listPolicies(req?: Request): Promise<PolicyRecord[]> {
    const policies: PolicyRecord[] = [];
    for (const entry of await this.searchPolicies('', req)) {
      policies.push(await this.toPolicyRecord(entry));
    }
    return policies.sort((a, b) => a.cn.localeCompare(b.cn));
  }

  private async toPolicyRecord(entry: RawEntry): Promise<PolicyRecord> {
    const defaultDn = (await this.readPolicyConfig()).dn;
    const record: PolicyRecord = {
      dn: entry.dn,
      cn: values(entry.cn)[0] ?? '',
      isDefault:
        !!defaultDn && normalizeDn(defaultDn) === normalizeDn(entry.dn),
    };
    return { ...record, ...typedPolicy(entry) };
  }

  /**
   * The directory form of a value a client sent for policy attribute `name`
   */
  private policyValue(name: string, value: unknown): string {
    switch (POLICY_ATTRIBUTE_TYPES[name]) {
      case 'integer':
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          (name === 'pwdCheckQuality' && value > 2)
        ) {
          throw new BadRequestError(
            name === 'pwdCheckQuality'
              ? 'pwdCheckQuality must be 0, 1 or 2'
              : `${name} must be a non-negative integer`
          );
        }
        return String(value);
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new BadRequestError(`${name} must be a boolean`);
        }
        return value ? 'TRUE' : 'FALSE';
      default:
        if (typeof value !== 'string' || value === '') {
          throw new BadRequestError(`${name} must be a non-empty string`);
        }
        return value;
    }
  }

  private async createPolicy(
    body: Record<string, unknown>,
    req?: Request
  ): Promise<PolicyRecord> {
    const { cn, ...attributes } = body;
    if (typeof cn !== 'string') throw new BadRequestError('cn required');
    try {
      validateDnValue(cn, 'cn');
    } catch (error) {
      throw new BadRequestError((error as Error).message);
    }
    const existing = await this.findPolicy(cn, req).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    if (existing) {
      throw new ConflictError(
        `A password policy is named ${cn}: ${existing.dn}`
      );
    }

    // pwdPolicy is auxiliary: person, with a dummy sn, is the structural
    // class the OpenLDAP administrator's guide gives it
    const objectClass = ['top', 'person', 'pwdPolicy'];
    const entry: Record<string, string | string[]> = {
      objectClass,
      cn,
      sn: cn,
      pwdAttribute: 'userPassword',
    };
    for (const [name, value] of Object.entries(attributes)) {
      if (!isWritablePolicyAttribute(name)) {
        throw new BadRequestError(`${name} cannot be written`);
      }
      if (value !== null) entry[name] = this.policyValue(name, value);
    }
    if (CHECKER_ATTRS.some(name => name in entry)) {
      objectClass.push('pwdPolicyChecker');
    }

    try {
      await this.server.ldap.add(
        `cn=${escapeDnValue(cn)},${this.policyBase()}`,
        entry,
        req
      );
    } catch (error) {
      if (extractLdapCode(error) !== 32) throw error;
      throw new NotFoundError(
        `${this.policyBase()} does not exist: create it or change --ppolicy-base`
      );
    }
    this.forgetPolicies();
    return this.toPolicyRecord(await this.findPolicy(cn, req));
  }

  private async updatePolicy(
    cn: string,
    body: Record<string, unknown>,
    req?: Request
  ): Promise<PolicyRecord> {
    const entry = await this.findPolicy(cn, req);
    const current = await this.toPolicyRecord(entry);
    const replace: Record<string, string> = {};
    const remove: string[] = [];
    for (const [name, value] of Object.entries(body)) {
      if (!isWritablePolicyAttribute(name)) {
        // A client sending back what it was served repeats what it cannot
        // change
        const same =
          name === 'dn'
            ? typeof value === 'string' &&
              normalizeDn(value) === normalizeDn(current.dn)
            : Object.prototype.hasOwnProperty.call(current, name) &&
              isDeepStrictEqual(current[name], value);
        if (same) continue;
        throw new BadRequestError(`${name} cannot be written`);
      }
      if (value !== null) replace[name] = this.policyValue(name, value);
      else if (current[name] !== undefined) remove.push(name);
    }

    const changes: ModifyRequest = {};
    if (Object.keys(replace).length > 0) changes.replace = replace;
    if (remove.length > 0) changes.delete = remove;
    if (!changes.replace && !changes.delete) return current;
    const classes = values(entry.objectClass).map(oc => oc.toLowerCase());
    if (
      CHECKER_ATTRS.some(name => name in replace) &&
      !classes.includes('pwdpolicychecker')
    ) {
      changes.add = { objectClass: 'pwdPolicyChecker' };
    }

    await this.server.ldap.modify(entry.dn, changes, req);
    this.forgetPolicies();
    return this.toPolicyRecord(await this.findPolicy(cn, req));
  }

  private async deletePolicy(cn: string, req?: Request): Promise<void> {
    const entry = await this.findPolicy(cn, req);
    const defaultDn = (await this.readPolicyConfig()).dn;
    if (defaultDn && normalizeDn(defaultDn) === normalizeDn(entry.dn)) {
      throw new ConflictError(`${entry.dn} is the default password policy`);
    }
    // Searched as the server: an entry the caller cannot read still uses
    // the policy
    const users = (await this.server.ldap.search(
      {
        filter: `(pwdPolicySubentry=${escapeLdapFilter(entry.dn)})`,
        scope: 'sub',
        attributes: ['1.1'],
        sizeLimit: 1,
        paged: false,
      },
      this.config.ldap_base as string
    )) as SearchResult;
    if (users.searchEntries.length > 0) {
      throw new ConflictError(
        `${entry.dn} is still applied to at least one entry`
      );
    }
    await this.server.ldap.delete(entry.dn, req);
    this.forgetPolicies();
  }

  private async assignPolicy(
    userId: string,
    policy: string | null,
    req?: Request
  ): Promise<{ dn: string; policy: string | null }> {
    const dn = this.resolveUserDn(userId);
    if (policy === null) {
      // Deleted without reading first: an ACL hiding pwdPolicySubentry
      // would show it absent while the entry still holds it
      try {
        await this.server.ldap.modify(
          dn,
          { delete: ['pwdPolicySubentry'] },
          req
        );
      } catch (error) {
        if (extractLdapCode(error) !== 16) throw error;
      }
      return { dn, policy: null };
    }
    const entry = await this.findPolicy(policy, req);
    await this.server.ldap.modify(
      dn,
      { replace: { pwdPolicySubentry: entry.dn } },
      req
    );
    return { dn, policy: entry.dn };
  }

  private param(req: Request, name: string): string {
    const value = req.params[name];
    return Array.isArray(value) ? value[0] : value;
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
        listPolicies: `${apiPrefix}/v1/password-policies`,
        policy: `${apiPrefix}/v1/password-policies/:cn`,
        assignPolicy: `${apiPrefix}/v1/users/:id/password-policy`,
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
      ldapPolicy: this.lastDefaultPolicy,
    };
  }
}
