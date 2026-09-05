/**
 * Utility functions
 * @author Xavier Guimard <xguimard@linagora.com>
 */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import type { Config } from '../bin';

import { BadRequestError } from './errors';
import { getLogger } from './expressFormatedResponses';

const logger = getLogger();

// Regex caching utilities - shared across plugins to avoid duplication
// NOTE: This cache is designed for static patterns from schemas, NOT for user input.
// Using dynamic user-generated patterns would cause unbounded memory growth.
// Current usage is limited to schema validation patterns which are finite.
const regexCache = new Map<string, RegExp>();

/**
 * Get a compiled RegExp from cache, or compile and cache it
 * This avoids recompiling the same regex patterns repeatedly
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags
 * @returns The compiled RegExp
 */
export function getCompiledRegex(pattern: string, flags?: string): RegExp {
  const key = flags ? `${pattern}:${flags}` : pattern;
  let regex = regexCache.get(key);
  if (!regex) {
    regex = new RegExp(pattern, flags);
    regexCache.set(key, regex);
  }
  return regex;
}

/**
 * Escape special regex characters in a string
 * Useful when building dynamic regex patterns from user input
 *
 * @param str - The string to escape
 * @returns The escaped string safe for use in RegExp
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// launchHooks launches hooks asynchroniously, errors are reported and ignored.
//
// Calling convention: VARIADIC. The trailing args are spread into each hook:
//     launchHooks(hooks, a, b)   →   hook(a, b)
//
// Do NOT pre-pack arguments into an array — `launchHooks(hooks, [a, b])`
// becomes `hook([a, b])` and any hook reading `a.foo` silently no-ops.
// (See PR #66 for the SCIM bug this caused.)
//
// Mirror the hook's declared signature:
//     VoidHook<[A, B]>           (variadic)        → launchHooks(hooks, a, b)
//     (args: [A, B]) => void     (packed-tuple)    → launchHooks(hooks, [a, b])
// LDAP "*done" hooks still use the packed-tuple form; SCIM "*done" hooks use
// VoidHook. Check src/hooks.ts before adding a new call site.
export const launchHooks = async (
  hooks: Function[] | undefined,
  ...args: unknown[]
): Promise<void> => {
  if (hooks) {
    for (const hook of hooks) {
      if (hook) {
        try {
          await hook(...args);
        } catch (e: unknown) {
          logger.error('Hook error', e);
        }
      }
    }
  }
};

// launchHooksChained threads a single value through each hook, collecting the
// returned (possibly modified) value. Any error stops the chain.
//
// Calling convention: SINGLE PACKED ARG. If a chained hook needs several
// inputs, pack them in a tuple — that is what `ChainedHook<[A, B]>` declares.
// Unlike launchHooks, the arg is NOT spread; passing `[a, b]` is correct here.
export const launchHooksChained = async <T>(
  hooks: Function[] | undefined,
  args: T
): Promise<T> => {
  if (hooks) {
    for (const hook of hooks) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      if (hook) args = await hook(args);
    }
  }
  return args;
};

export const transformSchemas = (
  schemas: string | Buffer,
  config: Config
): string => {
  const str = schemas.toString().replace(/__(\S+)__/g, (_, prm) => {
    if (!prm || typeof prm !== 'string') return _;
    const key: string = prm.trim().toLowerCase();
    if (config[key]) {
      if (typeof config[key] !== 'object') return config[key] as string;
      return JSON.stringify(config[key]);
    }
    return _;
  });
  return str;
};

// LDAP utilities

/**
 * Escape special characters in LDAP filter values according to RFC 4515
 * Prevents LDAP injection attacks by escaping characters that have special meaning in LDAP filters
 *
 * @param value - The value to escape
 * @returns The escaped value safe for use in LDAP filters
 *
 * @example
 * ```typescript
 * escapeLdapFilter('user*')
 * // => 'user\\2a'
 *
 * escapeLdapFilter('Smith, John (admin)')
 * // => 'Smith, John \\28admin\\29'
 * ```
 */
export function escapeLdapFilter(value: string): string {
  return value
    .replace(/\\/g, '\\5c') // backslash
    .replace(/\*/g, '\\2a') // asterisk
    .replace(/\(/g, '\\28') // left paren
    .replace(/\)/g, '\\29') // right paren
    .replace(/\0/g, '\\00'); // null
}

/**
 * Build the LDAP filter of a list search: a substring match on one attribute,
 * or on any of several.
 *
 * The value is escaped, so nothing a client types can reach the filter as
 * syntax; the attribute names cannot be escaped — they *are* syntax — so they
 * are checked against what an LDAP attribute name may contain and refused
 * otherwise.
 *
 * Every list route builds the same filter, and a client asking for a mail
 * address expects the same answer whichever entity it is asking about.
 *
 * @param match - The substring to look for
 * @param attribute - One attribute name, or several separated by commas
 * @returns The LDAP filter
 * @throws BadRequestError when an attribute name is not one
 *
 * @example
 * ```typescript
 * substringSearchFilter('ali', 'cn,mail')
 * // => '(|(cn=*ali*)(mail=*ali*))'
 * ```
 */
export function substringSearchFilter(
  match: string,
  attribute: string
): string {
  // Validate LDAP attribute name (alphanumeric + hyphen, starting with letter)
  const attributePattern = /^[a-zA-Z][a-zA-Z0-9-]*$/;
  // One name, or several separated by commas. Looking for a person by
  // surname meant knowing to switch a selector to the attribute that holds it
  // first, which is knowledge about the schema asked of someone searching
  // precisely because they do not have it.
  const names = attribute
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  if (names.length === 0 || !names.every(name => attributePattern.test(name)))
    throw new BadRequestError('Invalid LDAP attribute name');
  const escapedMatch = escapeLdapFilter(match);
  const clauses = names.map(name => `(${name}=*${escapedMatch}*)`);
  return clauses.length === 1 ? clauses[0] : `(|${clauses.join('')})`;
}

/**
 * Escape special characters in LDAP DN attribute values according to RFC 4514
 * Prevents LDAP injection attacks by escaping characters that have special meaning in DNs
 *
 * @param value - The value to escape
 * @returns The escaped value safe for use in LDAP DN attribute values
 *
 * @example
 * ```typescript
 * escapeDnValue('Smith, John')
 * // => 'Smith\\, John'
 *
 * escapeDnValue('user+admin')
 * // => 'user\\+admin'
 * ```
 */
export function escapeDnValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\') // backslash (must be first)
    .replace(/,/g, '\\,') // comma
    .replace(/\+/g, '\\+') // plus
    .replace(/"/g, '\\"') // double quote
    .replace(/</g, '\\<') // less than
    .replace(/>/g, '\\>') // greater than
    .replace(/;/g, '\\;') // semicolon
    .replace(/=/g, '\\=') // equals (in value only)
    .replace(/\0/g, '\\00') // null
    .replace(/^\s/, '\\ ') // leading space
    .replace(/\s$/, '\\ ') // trailing space
    .replace(/^#/, '\\#'); // leading hash
}

/**
 * Unescape special characters in LDAP DN attribute values according to RFC 4514
 * Reverses the escaping done by escapeDnValue
 *
 * @param value - The escaped value to unescape
 * @returns The unescaped original value
 *
 * @example
 * ```typescript
 * unescapeDnValue('Smith\\, John')
 * // => 'Smith, John'
 *
 * unescapeDnValue('user\\+admin')
 * // => 'user+admin'
 * ```
 *
 * @throws BadRequestError if `value` is not a string
 */
export function unescapeDnValue(value: string): string {
  // Same unbounded-loop hazard as {@link parseDn}: the loop below is driven by
  // `value.length`, which a JSON body can forge.
  if (typeof value !== 'string') {
    throw new BadRequestError('DN value must be a string');
  }

  let result = '';
  let i = 0;

  while (i < value.length) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];

      // Handle hex-encoded characters (e.g., \00 for null, \5c for backslash)
      if (/[0-9a-fA-F]/.test(next) && i + 2 < value.length) {
        const hex = value.substring(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }

      // Handle standard escaped characters
      result += next;
      i += 2;
    } else {
      result += value[i];
      i++;
    }
  }

  return result;
}

/**
 * Validate a value intended for use in LDAP DN attribute values
 * Rejects control characters and other problematic inputs
 *
 * @param value - The value to validate
 * @param fieldName - Name of the field (for error messages)
 * @throws Error if the value contains invalid characters
 *
 * @example
 * ```typescript
 * validateDnValue('valid-user', 'uid');
 * // => OK
 *
 * validateDnValue('user\x00name', 'uid');
 * // => throws Error: uid contains invalid control characters
 * ```
 */
export function validateDnValue(value: string, fieldName: string): void {
  if (value == null || typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  // Reject control characters (0x00-0x1F and 0x7F)
  // These are invisible and can cause issues in logs, LDIF exports, etc.
  // The control characters are the point of this check, hence the exemption
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(`${fieldName} contains invalid control characters`);
  }

  // Reject zero-width and other invisible Unicode characters
  // U+200B (zero-width space), U+200C-U+200F, U+FEFF (BOM)
  if (/[\u200B-\u200F\uFEFF]/.test(value)) {
    throw new Error(`${fieldName} contains invalid invisible characters`);
  }
}

// LDAP DN utilities

/**
 * Parse a Distinguished Name (DN) into its component parts (RDNs)
 * Handles escaped commas and other special characters
 *
 * @param dn - The DN to parse
 * @returns Array of RDN components
 *
 * @example
 * ```typescript
 * parseDn('uid=user,ou=users,dc=example,dc=com')
 * // => ['uid=user', 'ou=users', 'dc=example', 'dc=com']
 *
 * parseDn('cn=Smith\\, John,ou=users,dc=example,dc=com')
 * // => ['cn=Smith\\, John', 'ou=users', 'dc=example', 'dc=com']
 * ```
 *
 * @throws BadRequestError if `dn` is not a string
 */
export function parseDn(dn: string): string[] {
  // DNs reach us straight from JSON request bodies, where the declared
  // `string` type is a compile-time promise only. An object such as
  // `{"length": 1e100}` would drive the loop below for 10^100 iterations
  // (CWE-834), so refuse anything that is not a real string: its length is
  // then bounded by the body-size limit. Callers already relied on this
  // throwing (it used to be an opaque TypeError); a BadRequestError just
  // turns the 500 into the 400 it always should have been.
  if (typeof dn !== 'string') {
    throw new BadRequestError('DN must be a string');
  }

  const parts: string[] = [];
  let current = '';
  let escaped = false;

  for (let i = 0; i < dn.length; i++) {
    const char = dn[i];

    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Don't forget the last part
  if (current) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Extract the parent DN from a DN
 * Removes the first RDN component to get the parent branch
 *
 * @param dn - The DN to extract parent from
 * @returns The parent DN, or the original DN if it has no parent
 *
 * @example
 * ```typescript
 * getParentDn('uid=user,ou=users,dc=example,dc=com')
 * // => 'ou=users,dc=example,dc=com'
 *
 * getParentDn('dc=com')
 * // => 'dc=com'
 * ```
 */
export function getParentDn(dn: string): string {
  const parts = parseDn(dn);

  if (parts.length <= 1) {
    return dn;
  }

  return parts.slice(1).join(',');
}

/**
 * Extract the RDN (Relative Distinguished Name) from a DN
 * Returns the first component of the DN
 *
 * @param dn - The DN to extract RDN from
 * @returns The RDN component
 *
 * @example
 * ```typescript
 * getRdn('uid=user,ou=users,dc=example,dc=com')
 * // => 'uid=user'
 * ```
 */
export function getRdn(dn: string): string {
  const parts = parseDn(dn);
  return parts[0] || '';
}

/**
 * Extract the *value* of the first RDN of a DN, with its escapes removed
 *
 * Where {@link getRdn} returns `ou=Test Org`, this returns `Test Org`: the
 * name the entry is known by, which is what a path or a label is built from.
 *
 * @param dn - The DN to read
 * @returns The value, or an empty string when the DN has no RDN
 *
 * @example
 * ```typescript
 * rdnValue('ou=Test\\, Org,ou=organization,dc=example,dc=com')
 * // => 'Test, Org'
 * ```
 */
export function rdnValue(dn: string): string {
  const match = /^[^=]+=((?:\\.|[^,])*)/.exec(dn);
  return match ? match[1].replace(/\\(.)/g, '$1') : '';
}

/**
 * Check if a DN is a child of another DN
 *
 * @param dn - The DN to check
 * @param parentDn - The potential parent DN
 * @returns True if dn is a child of parentDn
 *
 * @example
 * ```typescript
 * isChildOf('uid=user,ou=users,dc=example,dc=com', 'ou=users,dc=example,dc=com')
 * // => true
 *
 * isChildOf('uid=user,ou=users,dc=example,dc=com', 'ou=groups,dc=example,dc=com')
 * // => false
 * ```
 */
export function isChildOf(dn: string, parentDn: string): boolean {
  const dnLower = dn.toLowerCase();
  const parentLower = parentDn.toLowerCase();

  // DN must end with parent DN
  if (!dnLower.endsWith(parentLower)) {
    return false;
  }

  // DN must be longer than parent (it's a child, not the same)
  if (dnLower.length === parentLower.length) {
    return false;
  }

  // Check that there's a comma separator before the parent DN part
  const beforeParent = dnLower.substring(
    0,
    dnLower.length - parentLower.length
  );
  return beforeParent.endsWith(',');
}

/**
 * Normalize a DN into a canonical, comparable form.
 *
 * Parses the DN into RDNs (honouring escaped commas via {@link parseDn}), then
 * for each RDN lowercases it, collapses the optional whitespace around the `=`
 * of every attribute-value assertion, and sorts the assertions of a
 * multi-valued RDN so their ordering is irrelevant. The RDNs are re-joined with
 * `,`. Empty components (e.g. from a trailing separator) are dropped.
 *
 * This makes equality / suffix comparisons robust to case, surrounding
 * whitespace and multi-valued RDN ordering — unlike a raw string match.
 *
 * @param dn - The DN to normalize
 * @returns The canonical form
 *
 * @example
 * ```typescript
 * normalizeDn('UID=x, ou=AppAccounts ,dc=Example,dc=com')
 * // => 'uid=x,ou=appaccounts,dc=example,dc=com'
 * ```
 */
export function normalizeDn(dn: string): string {
  return parseDn(dn)
    .map(rdn =>
      rdn
        .split('+')
        .map(atav => {
          // Split on the first `=` (the type/value separator — attribute types
          // never contain `=`, and value `=` are escaped as `\=`) and trim each
          // side. Done with indexOf rather than a `\s*=\s*` regex to avoid the
          // polynomial scan a regex incurs on untrusted DN strings (ReDoS).
          const eq = atav.indexOf('=');
          const normalized =
            eq === -1
              ? atav.trim()
              : `${atav.slice(0, eq).trim()}=${atav.slice(eq + 1).trim()}`;
          return normalized.toLowerCase();
        })
        .sort()
        .join('+')
    )
    .filter(rdn => rdn.length > 0)
    .join(',');
}

/**
 * Check whether a DN is a branch base itself or sits anywhere below it.
 *
 * Comparison is done RDN by RDN on the {@link normalizeDn} form, so it is
 * robust to case, whitespace and escaped separators. A naive string suffix
 * match can give a false negative (e.g. `ou=AppAccounts` vs `ou=appaccounts`,
 * or `uid=x, ou=…` with stray whitespace), which is exactly what lets a
 * re-entrant LDAP change event slip through a branch guard.
 *
 * Unlike {@link isChildOf}, this returns true when `dn` equals `base` as well.
 *
 * @param dn - The candidate DN
 * @param base - The branch base DN
 * @returns true if `dn` equals `base` or is a descendant of it
 *
 * @example
 * ```typescript
 * isDnInBranch('uid=x,ou=app,dc=e,dc=c', 'ou=app,dc=e,dc=c') // => true
 * isDnInBranch('ou=app,dc=e,dc=c', 'ou=app,dc=e,dc=c')       // => true
 * isDnInBranch('uid=x,ou=users,dc=e,dc=c', 'ou=app,dc=e,dc=c') // => false
 * ```
 */
export function isDnInBranch(dn: string, base: string): boolean {
  const baseParts = normalizeDn(base).split(',').filter(Boolean);
  if (baseParts.length === 0) return false;
  const dnParts = normalizeDn(dn).split(',').filter(Boolean);
  if (dnParts.length < baseParts.length) return false;
  const tail = dnParts.slice(dnParts.length - baseParts.length);
  return tail.every((part, i) => part === baseParts[i]);
}

/**
 * Wrapper for async Express route handlers to catch errors and pass them to error middleware
 * This ensures that errors in async routes are properly handled and don't crash the server
 *
 * @param fn - The async route handler function
 * @returns A wrapped handler that catches errors
 *
 * @example
 * ```typescript
 * app.get('/api/data', asyncHandler(async (req, res) => {
 *   const data = await fetchData();
 *   res.json(data);
 * }));
 * ```
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
