/**
 * Utility functions
 * @author Xavier Guimard <xguimard@linagora.com>
 */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import type { Config } from '../bin';

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

// launchHooks launches hooks asynchroniously, errors are reported and ignored
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

// launchHooksChained give the uniq argument (may be an array if you need to pas more than one arg)
// to each hook and collect the changes if any
// Any error stops the process
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
 */
export function parseDn(dn: string): string[] {
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
