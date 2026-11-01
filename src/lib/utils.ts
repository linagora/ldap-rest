/**
 * Utility functions
 * @author Xavier Guimard <xguimard@linagora.com>
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import type { Config } from '../bin';

import type { AttributeValue } from './ldapActions';
import { BadRequestError } from './errors';

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

export { hookOwner, recordHookOwner, runAsHookOwner } from './hookBus';

export const transformSchemas = (
  schemas: string | Buffer,
  config: Config
): string => {
  const str = schemas.toString().replace(/__(\S+)__/g, (_, prm) => {
    if (!prm || typeof prm !== 'string') return _;
    const key: string = prm.trim().toLowerCase();
    const values = config as unknown as Record<string, unknown>;
    if (values[key]) {
      if (typeof values[key] !== 'object') return values[key] as string;
      return JSON.stringify(values[key]);
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
 * `pattern` with every `placeholder` replaced by `value`, taken literally:
 * `String.replace` would expand `$&`, `$'`, `` $` `` and `$$` in a value
 * that a request chose.
 */
export function fillPattern(
  pattern: string,
  placeholder: string,
  value: string
): string {
  return pattern.split(placeholder).join(value);
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
  let escaped = value
    .replace(/[\\,+"<>;=]/g, char => `\\${char}`)
    // Control characters are the point of this class, hence the exemption
    // eslint-disable-next-line no-control-regex
    .replace(/[\0-\x1f\x7f]/g, char => `\\${hexByte(char.charCodeAt(0))}`);
  // Only a space is special at either end (RFC 4514 §2.4); a Unicode space
  // is a character of the value. Both ends are judged on the original
  // value, so a lone space is escaped once.
  if (value.startsWith(' ')) escaped = `\\${escaped}`;
  if (value.length > 1 && value.endsWith(' '))
    escaped = `${escaped.slice(0, -1)}\\ `;
  if (value.startsWith('#')) escaped = `\\${escaped}`;
  return escaped;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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
  // RFC 4514 hex escapes are the bytes of the value's UTF-8 encoding, so a run
  // of them (e.g. \C3\A9 for é) must be decoded together, not byte by byte.
  let bytes: number[] = [];
  const flushBytes = (): void => {
    if (bytes.length) {
      // A byte that is not UTF-8 (a Latin-1 escape from a legacy writer) is
      // one char rather than U+FFFD, which would collapse distinct values
      for (const char of utf8Chars(bytes))
        result += typeof char === 'number' ? String.fromCharCode(char) : char;
      bytes = [];
    }
  };

  while (i < value.length) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];

      // Handle hex-encoded characters (e.g., \00 for null, \5c for backslash)
      if (/[0-9a-fA-F]/.test(next) && i + 2 < value.length) {
        const hex = value.substring(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }

      // Handle standard escaped characters
      flushBytes();
      result += next;
      i += 2;
    } else {
      flushBytes();
      result += value[i];
      i++;
    }
  }

  flushBytes();
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

/** A space, or the ASCII whitespace a configured DN may end in. */
function asciiSpace(char: string): boolean {
  return char === ' ' || (char >= '\t' && char <= '\r');
}

/**
 * Trim the whitespace around a DN component, but not a trailing space its
 * backslash escapes: `ou=a\ ` names a value ending in a space.
 */
function trimUnescaped(part: string): string {
  // ASCII whitespace only: `trim()` also takes characters the directory
  // keeps, such as U+1680
  let start = 0;
  let end = part.length;
  while (start < end && asciiSpace(part[start])) start++;
  while (end > start && asciiSpace(part[end - 1])) end--;
  if (end < part.length) {
    let backslashes = 0;
    for (let i = end - 1; i >= start && part[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 1) end++;
  }
  return part.slice(start, end);
}

/**
 * Parse a Distinguished Name (DN) into its component parts (RDNs)
 * Handles escaped commas and other special characters, and what OpenLDAP
 * still reads from LDAPv2 (RFC 1779): `;` separating RDNs as `,` does, and
 * a value in double quotes holding either
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
  let quoted = false;

  for (let i = 0; i < dn.length; i++) {
    const char = dn[i];

    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === '"' && (quoted || opensValue(current))) {
      current += char;
      quoted = !quoted;
    } else if (!quoted && (char === ',' || char === ';')) {
      parts.push(trimUnescaped(current));
      current = '';
    } else {
      current += char;
    }
  }

  // Read otherwise, the rest of the DN would be one value
  if (quoted) throw new BadRequestError('DN has an unbalanced quote');

  // Don't forget the last part
  if (current) {
    parts.push(trimUnescaped(current));
  }

  return parts;
}

/**
 * Whether a double quote here opens a value: only right after its `=`, as
 * LDAPv2 quotes a whole value. Anywhere else it is a character of it.
 */
function opensValue(before: string): boolean {
  const text = before.trimEnd();
  if (!text.endsWith('=')) return false;
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

/**
 * Whether a string has the shape of a DN: RDNs of `type=value` assertions,
 * a type being a name or an OID. What the directory would refuse as
 * `invalidDNSyntax` is answered without asking it.
 *
 * @param dn - The string
 * @returns whether it reads as a DN
 */
export function isDnSyntax(dn: string): boolean {
  let rdns: string[];
  try {
    rdns = parseDn(dn);
  } catch {
    return false;
  }
  if (rdns.length === 0) return false;
  const type = /^\s*(?:[A-Za-z][A-Za-z0-9-]*|(?:OID\.)?\d+(?:\.\d+)+)\s*=/i;
  return rdns.every(rdn => {
    if (!rdn) return false;
    // The assertions of a multi-valued RDN, split on the unescaped `+`
    const parts: string[] = [];
    let current = '';
    let escaped = false;
    for (const char of rdn) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '+') {
        parts.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    parts.push(current);
    return parts.every(part => type.test(part));
  });
}

/** The characters RFC 4514 §3 lets a backslash escape. */
const RFC4514_ESCAPED = new Set([
  '"',
  '+',
  ',',
  ';',
  '<',
  '>',
  '\\',
  '#',
  '=',
  ' ',
]);

/**
 * Whether every escape in `dn` is one RFC 4514 §3 defines: an escaped
 * special (`" + , ; < > \ # =` or a space) or a pair of hex digits.
 *
 * {@link parseDn} and {@link unescapeDnValue} read a DN permissively, as a
 * directory may answer one; a DN a caller writes is held to the grammar.
 *
 * @param dn - The DN to check
 * @returns whether its escapes are RFC 4514 escapes
 */
export function hasOnlyRfc4514Escapes(dn: string): boolean {
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] !== '\\') continue;
    const next = dn[i + 1];
    // A backslash at the end escapes nothing
    if (next === undefined) return false;
    if (RFC4514_ESCAPED.has(next)) {
      i++;
      continue;
    }
    if (/^[0-9a-fA-F]{2}$/.test(dn.slice(i + 1, i + 3))) {
      i += 2;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Refuse a DN a client wrote when it holds an escape RFC 4514 does not
 * define.
 *
 * The readers here are permissive on purpose, because they also read what a
 * directory answers. A DN a caller sends is held to the grammar instead, so
 * the server only ever writes a spelling the directory would produce itself.
 *
 * @param dn - The DN the client wrote
 * @param what - What to name in the refusal
 * @throws BadRequestError when an escape is not one RFC 4514 defines
 */
export function assertRfc4514Escapes(dn: string, what: string): void {
  if (!hasOnlyRfc4514Escapes(dn))
    throw new BadRequestError(
      `${what} uses an escape RFC 4514 does not define`
    );
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
  const [rdn] = parseDn(dn);
  return rdnValueOf(rdn);
}

/**
 * A value without the quotes LDAPv2 (RFC 2253) wraps it in, where it is one
 * value: the closing quote is not escaped. RFC 4514 has no quoting, but a
 * DN written the old way reads as the value it holds.
 */
function unquotedValue(value: string): string {
  let backslashes = 0;
  for (let i = value.length - 2; i > 0 && value[i] === '\\'; i--) backslashes++;
  const quoted =
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    backslashes % 2 === 0;
  return quoted ? value.slice(1, -1) : value;
}

/** The value of one RDN, trimmed as `parseDn` leaves it and decoded. */
function rdnValueOf(rdn: string | undefined): string {
  if (!rdn) return '';
  const eq = rdn.indexOf('=');
  if (eq <= 0) return '';
  // parseDn trimmed the end, keeping the space a backslash escapes
  let start = eq + 1;
  while (start < rdn.length && asciiSpace(rdn[start])) start++;
  return unescapeDnValue(unquotedValue(rdn.slice(start)));
}

/**
 * Insignificant spaces (RFC 4518 §2.6.1): none at either end, and one for a
 * run of them.
 */
function dropSpaces(chars: string[]): string[] {
  const kept = chars.filter((char, i) => char !== ' ' || chars[i - 1] !== ' ');
  let start = 0;
  let end = kept.length;
  while (start < end && kept[start] === ' ') start++;
  while (end > start && kept[end - 1] === ' ') end--;
  return kept.slice(start, end);
}

/**
 * A naming value as the directory folds it: Unicode compatibility
 * equivalence (NFKC, which makes `cafe\u0301` `café`) and its insignificant
 * spaces dropped ({@link dropSpaces}). Case is kept — the directory folds it
 * too, but a name is written as the caller spells it.
 *
 * A value another spelling of which the directory calls the same name is
 * written as this one, so the RDN and the naming attribute spell one value.
 */
function foldRdnValue(value: string): string {
  return dropSpaces([...value.normalize('NFKC')]).join('');
}

/**
 * Read the name of an entry written as a DN: the value of its first RDN when
 * that RDN asserts `attribute` alone, under `base` when one is given.
 *
 * The value is decoded as {@link rdnValue} decodes it, then folded as the
 * directory folds it ({@link foldRdnValue}): it is the naming attribute's
 * value, the one a write puts back in `attribute=…,base`, and a caller
 * spelling it in a way the directory considers the same name gets that name,
 * not a second one.
 *
 * @param dn - The DN to read
 * @param attribute - The attribute the first RDN must assert
 * @param base - The branch the entry belongs to, when the DN names it whole
 * @returns The name, or `null` when the RDN asserts another attribute, names
 * another branch, or is no DN
 *
 * @example
 * ```typescript
 * assertedRdnValue('uid=Smith\\,John,ou=users,dc=example,dc=com', 'uid')
 * // => 'Smith,John'
 * ```
 */
export function assertedRdnValue(
  dn: string,
  attribute: string,
  base?: string
): string | null {
  // Linear in the input, where a pattern of `\\.` against `[^,]` would try
  // every way of splitting a run of escapes before failing: the RDN is read
  // once, and the parent only when a base is given
  const [rdn] = parseDn(dn);
  const eq = rdn ? rdn.indexOf('=') : -1;
  if (eq <= 0) return null;
  if (rdn.slice(0, eq).trim().toLowerCase() !== attribute.toLowerCase())
    return null;
  // A multi-valued RDN (`uid=a+cn=b`) is not what a naming attribute names;
  // `splitRdn` reads `uid="a+b"` as one assertion, as the rest of the code
  if (splitRdn(rdn).length > 1) return null;
  if (base !== undefined && !isDirectChildOf(dn, base)) return null;
  return foldRdnValue(rdnValueOf(rdn));
}

/**
 * Whether `attribute=` starts `id`: the caller sent a DN rather than a bare
 * naming value.
 *
 * Deciding this before `assertedRdnValue` matters: a string it refuses — a
 * multi-valued RDN, another branch — is still a DN, and read as a bare value
 * it would be written whole.
 */
export function namesByDn(id: string, attribute: string): boolean {
  try {
    const [rdn] = parseDn(id);
    const eq = rdn ? rdn.indexOf('=') : -1;
    return (
      eq > 0 &&
      rdn.slice(0, eq).trim().toLowerCase() === attribute.toLowerCase()
    );
  } catch {
    return false;
  }
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
  // RDN by RDN: a suffix of the text took `cn=a\,ou=users,…`, an entry
  // beside `ou=users`, for one of its children. A DN that cannot be parsed
  // is no child.
  try {
    return isDnInBranch(dn, parentDn) && !isDnInBranch(parentDn, dn);
  } catch {
    return false;
  }
}

/**
 * Whether `dn` names a direct child of `base`: its parent is `base`, compared
 * as the directory compares DNs.
 *
 * `isChildOf` answers ancestry; this answers parent equality, which is what a
 * route that only serves one branch requires of a DN a client writes. The
 * comparison folds case, spacing and the escapes the directory reads, so a
 * DN created under one spelling is addressed under another.
 *
 * @param dn - The DN to check
 * @param base - The branch its parent has to be
 * @returns True when the DN has a parent and that parent is `base`
 *
 * @example
 * ```typescript
 * isDirectChildOf('uid=x,OU=Users , dc=example,dc=com', 'ou=users,dc=example,dc=com')
 * // => true
 * ```
 */
export function isDirectChildOf(dn: string, base: string): boolean {
  try {
    const [, ...parent] = parseDn(dn);
    return (
      parent.length > 0 && normalizeDn(parent.join(',')) === normalizeDn(base)
    );
  } catch {
    return false;
  }
}

/** A DN value's escapes: a run of hex pairs, or one escaped character. */
const DN_ESCAPE = /((?:\\[0-9a-fA-F]{2})+)|\\([^])/g;

/**
 * One spelling for a DN value (RFC 4514 §2.4): every escape decoded — the
 * directory answers `ou=Sales\2C EMEA` for what a configuration writes
 * `ou=Sales\, EMEA`, `\20` for `\ `, `\C3\A9` for `é` — then folded as
 * OpenLDAP's matching rules fold it: Unicode compatibility equivalence
 * (NFKC), which also makes a no-break or an ideographic space a space,
 * and its insignificant spaces dropped (at either end, and all but one of
 * a run). The characters that need it are escaped again with a
 * backslash: the specials anywhere, a `#` at the start. A control
 * character, or a hex pair that is not UTF-8, stays hex. A BER value (`#`
 * and hex pairs) is not decoded; one in double quotes (LDAPv2) is read as
 * it stands.
 *
 * It covers the spellings of the naming attributes, not the whole of RFC
 * 4518: the authorization hooks judge writes on the DN the directory
 * returns, and only what does not exist yet — a new DN, a configured
 * branch — rests on this.
 *
 * @param raw the value as written, after its `=`
 */
function canonicalValue(raw: string): string {
  const trimmed = trimUnescaped(raw);
  if (/^#(?:[0-9a-fA-F]{2})+$/.test(trimmed)) return trimmed;
  raw = unquotedValue(trimmed);
  // Each character, decoded; hex pairs that are not, kept as `\xx`
  const chars: string[] = [];
  let last = 0;
  const plain = (text: string): void => {
    for (const char of text) chars.push(char);
  };
  for (const match of raw.matchAll(DN_ESCAPE)) {
    plain(raw.slice(last, match.index));
    last = match.index + match[0].length;
    const [, hex, char] = match;
    if (char !== undefined) {
      chars.push(char);
      continue;
    }
    const bytes = hex
      .split('\\')
      .filter(Boolean)
      .map(pair => parseInt(pair, 16));
    for (const char of utf8Chars(bytes))
      if (typeof char === 'number') chars.push(`\\${hexByte(char)}`);
      else plain(char);
  }
  // A lone trailing backslash escapes nothing: it is one
  if (last < raw.length) plain(raw.slice(last));

  // Case, then Unicode equivalence (NFKC), in the order of RFC 4518 §2 and
  // of the directory's matching rules: `cafe\u0301` is `café`, `ﬁ` is
  // `fi`, a no-break space or an ideographic one is a space. Lower-casing
  // after NFKC would leave `T\u0308` as `t\u0308`, which NFKC composes
  const kept = (char: string): boolean => char.length === 3 && char[0] === '\\';
  const tokens: string[] = [];
  let run = '';
  for (const char of chars)
    if (kept(char)) {
      tokens.push(...run.toLowerCase().normalize('NFKC'), char);
      run = '';
    } else run += char;
  tokens.push(...run.toLowerCase().normalize('NFKC'));

  const folded = dropSpaces(tokens);
  let out = '';
  for (const [i, char] of folded.entries()) {
    if (kept(char)) out += char;
    else if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
      out += `\\${hexByte(char.charCodeAt(0))}`;
    else if (',+"\\<>;='.includes(char) || (i === 0 && char === '#'))
      out += `\\${char}`;
    else out += char;
  }
  return out;
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/**
 * The characters the bytes of a hex-escape run encode, sequence by
 * sequence: a byte that starts no valid UTF-8 sequence is given as a number,
 * and only that one, so that what a caller keeps as hex never holds a
 * sequence a second reading would decode.
 */
function utf8Chars(bytes: number[]): (string | number)[] {
  const out: (string | number)[] = [];
  const buffer = Uint8Array.from(bytes);
  for (let i = 0; i < bytes.length;) {
    const length = utf8Length(bytes[i]);
    let decoded: string | undefined;
    if (length && i + length <= bytes.length)
      try {
        decoded = utf8Decoder.decode(buffer.subarray(i, i + length));
      } catch {
        // not a sequence
      }
    if (decoded === undefined) out.push(bytes[i++]);
    else {
      out.push(...decoded);
      i += length;
    }
  }
  return out;
}

/** The length of the UTF-8 sequence a lead byte announces, 0 for none. */
function utf8Length(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >> 5 === 0b110) return 2;
  if (lead >> 4 === 0b1110) return 3;
  if (lead >> 3 === 0b11110) return 4;
  return 0;
}

/**
 * The attribute types of the directory by every name and OID they answer
 * to, each to its first name: OpenLDAP reads `organizationalUnitName=x` and
 * `2.5.4.11=x` as `ou=x`, so a DN must too, or a rule on `ou=x` would not
 * hold `2.5.4.11=x`. Seeded with the usual types and completed from the
 * directory schema at startup ({@link registerAttributeTypes}).
 */
const attributeTypeNames = new Map<string, string>();
/** The first name of each type, spelled as declared, by any of its names */
const attributeTypeSpellings = new Map<string, string>();

/**
 * Teach {@link normalizeDn} the names and OIDs of attribute types: each is
 * read as the type's first name.
 *
 * @param types attribute types, as `ldapSchema` parses them
 */
export function registerAttributeTypes(
  types: Iterable<{ oid: string; names: string[] }>
): void {
  for (const { oid, names } of types) {
    const canonical = (names[0] ?? oid).toLowerCase();
    for (const alias of [oid, ...names]) {
      attributeTypeNames.set(alias.toLowerCase(), canonical);
      attributeTypeSpellings.set(alias.toLowerCase(), names[0] ?? oid);
    }
  }
}

registerAttributeTypes([
  { oid: '2.5.4.0', names: ['objectClass'] },
  { oid: '2.5.4.3', names: ['cn', 'commonName'] },
  { oid: '2.5.4.4', names: ['sn', 'surname'] },
  { oid: '2.5.4.5', names: ['serialNumber'] },
  { oid: '2.5.4.6', names: ['c', 'countryName'] },
  { oid: '2.5.4.7', names: ['l', 'localityName'] },
  { oid: '2.5.4.8', names: ['st', 'stateOrProvinceName'] },
  { oid: '2.5.4.9', names: ['street', 'streetAddress'] },
  { oid: '2.5.4.10', names: ['o', 'organizationName'] },
  { oid: '2.5.4.11', names: ['ou', 'organizationalUnitName'] },
  { oid: '2.5.4.12', names: ['title'] },
  { oid: '2.5.4.42', names: ['givenName', 'gn'] },
  { oid: '2.5.4.43', names: ['initials'] },
  { oid: '2.5.4.46', names: ['dnQualifier'] },
  { oid: '2.5.4.65', names: ['pseudonym'] },
  { oid: '0.9.2342.19200300.100.1.1', names: ['uid', 'userid'] },
  { oid: '0.9.2342.19200300.100.1.3', names: ['mail', 'rfc822Mailbox'] },
  { oid: '0.9.2342.19200300.100.1.25', names: ['dc', 'domainComponent'] },
  { oid: '2.16.840.1.113730.3.1.241', names: ['displayName'] },
  { oid: '2.16.840.1.113730.3.1.3', names: ['employeeNumber'] },
  { oid: '1.3.6.1.1.1.1.0', names: ['uidNumber'] },
  { oid: '1.3.6.1.1.1.1.1', names: ['gidNumber'] },
]);

/**
 * The name an attribute type is known by, spelled as declared, from the
 * names and OIDs {@link registerAttributeTypes} was given: `COMMONNAME`,
 * `2.5.4.3` and `OID.2.5.4.3` are `cn`.
 *
 * @param type attribute name or OID
 * @returns the name, or undefined for a type it was not given
 */
export function knownAttributeName(type: string): string | undefined {
  return attributeTypeSpellings.get(type.toLowerCase().replace(/^oid\./, ''));
}

/**
 * The attribute types the first RDN of a DN names, as {@link normalizeDn}
 * reads them: `CN=a+2.5.4.11=b,…` names `cn` and `ou`.
 *
 * @param dn the DN
 */
export function rdnTypes(dn: string): string[] {
  return splitRdn(parseDn(dn)[0] ?? '').map(atav => {
    const eq = atav.indexOf('=');
    return eq === -1 ? '' : canonicalType(atav.slice(0, eq).trim());
  });
}

/** An attribute type of a DN as {@link normalizeDn} spells it. */
function canonicalType(type: string): string {
  // `OID.2.5.4.11`, the LDAPv2 spelling of an OID
  const name = type.toLowerCase().replace(/^oid\./, '');
  return attributeTypeNames.get(name) ?? name;
}

/**
 * The attribute-value assertions of an RDN: split on the `+` that are not
 * escaped, as `parseDn` splits a DN on its commas.
 */
function splitRdn(rdn: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  let quoted = false;
  for (const char of rdn) {
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"' && (quoted || opensValue(current))) quoted = !quoted;
    else if (char === '+' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
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
 * whitespace, multi-valued RDN ordering, the escapes a directory answers
 * with ({@link canonicalValue}) and the names and OIDs of an attribute type
 * ({@link registerAttributeTypes}) — unlike a raw string match.
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
  return normalizedRdns(dn).join(',');
}

/**
 * The RDNs of {@link normalizeDn}, kept apart: joined, an escaped separator
 * the directory spelled `\2C` would read as one that was not escaped.
 */
function normalizedRdns(dn: string): string[] {
  return parseDn(dn)
    .map(rdn =>
      splitRdn(rdn)
        .map(atav => {
          // Split on the first `=` (the type/value separator — attribute types
          // never contain `=`, and value `=` are escaped as `\=`) and trim each
          // side. Done with indexOf rather than a `\s*=\s*` regex to avoid the
          // polynomial scan a regex incurs on untrusted DN strings (ReDoS).
          const eq = atav.indexOf('=');
          if (eq === -1) return atav.trim().toLowerCase();
          return `${canonicalType(atav.slice(0, eq).trim())}=${canonicalValue(atav.slice(eq + 1)).toLowerCase()}`;
        })
        .sort()
        .join('+')
    )
    .filter(rdn => rdn.length > 0);
}

/**
 * Whether a member DN is the placeholder a `groupOfNames` holds so it stays
 * valid with no real member (`--group-dummy-user`).
 *
 * Compared as DNs rather than as text: the directory answers with its own
 * spelling, so the configured `uid=fakeUser,ou=users,…` has to match the
 * `uid=fakeuser, ou=users,…` a group may actually hold. A textual comparison
 * counted such a member as a real one — enough to make an empty group refuse
 * deletion, and to show the placeholder to SCIM clients.
 *
 * Every reader of the member list asks here, so the four of them cannot drift
 * apart again.
 *
 * @param member - The member DN to test
 * @param dummy - The configured placeholder DN, if any
 * @returns true when `member` is that placeholder; false when none is
 *          configured, as there is then no placeholder to hide
 *
 * @example
 * ```typescript
 * isDummyMemberDn('uid=fakeuser, ou=users,dc=e,dc=c', 'uid=fakeUser,ou=users,dc=e,dc=c')
 * // => true
 * ```
 */
export function isDummyMemberDn(
  member: unknown,
  dummy: string | undefined
): boolean {
  if (!dummy || typeof member !== 'string') return false;
  if (member === dummy) return true;
  try {
    return normalizeDn(member) === normalizeDn(dummy);
  } catch {
    // An unparsable DN is simply not the placeholder.
    return false;
  }
}

/**
 * The organization an entry is attached to, read off its link attribute
 * (`--ldap-organization-link-attribute`), or `undefined` when it is attached
 * to none.
 *
 * "None" arrives in three forms: the attribute missing, an empty array —
 * how ldapts answers an attribute that was asked for and is absent — and an
 * empty value. The empty array read as the branch "undefined" in one copy of
 * this logic, and nobody could write such an entry. Every reader of the link
 * asks here, so the copies cannot drift apart again.
 *
 * @param value - The link attribute as a search returned it
 * @returns its first value, or `undefined` when there is none
 */
export function organizationLink(
  value: AttributeValue | undefined
): string | undefined {
  // The first value that names something: an entry stored with an empty
  // one beside an organization, before such writes were refused, is that
  // organization's
  for (const one of Array.isArray(value) ? value : [value]) {
    if (one === undefined || one === null) continue;
    const link = String(one).trim();
    if (link.length > 0) return link;
  }
  return undefined;
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
  const baseParts = normalizedRdns(base);
  if (baseParts.length === 0) return false;
  const dnParts = normalizedRdns(dn);
  if (dnParts.length < baseParts.length) return false;
  const tail = dnParts.slice(dnParts.length - baseParts.length);
  return tail.every((part, i) => part === baseParts[i]);
}

/**
 * Tell whether a rename moved an entry into the trash branch.
 *
 * `core/ldap/trash` turns a deletion into such a move, so the DN it frees is
 * as free as a deleted one, without any `ldapdeletedone`.
 *
 * @param trashBase the `--trash-base`, if any
 * @param oldDn DN before the rename
 * @param newDn DN after it
 * @returns true when the entry entered the trash branch
 */
export function movedToTrash(
  trashBase: string | undefined,
  oldDn: string,
  newDn: string
): boolean {
  return (
    !!trashBase &&
    isDnInBranch(newDn, trashBase) &&
    !isDnInBranch(oldDn, trashBase)
  );
}

/**
 * Parse a directory date: an LDAP generalized time or anything `Date`
 * understands.
 *
 * A generalized time (RFC 4517 section 3.3.13) is `yyyyMMddHH`, then optional
 * minutes and seconds, an optional fraction of the last unit given, and a zone:
 * `Z` or an offset of hours with optional minutes (`+02`, `-0530`). `Date` reads
 * none of the shorter forms, and not an offset of bare hours, so they are
 * computed here rather than rewritten into an ISO string it might refuse.
 *
 * @param raw value as stored or submitted
 * @returns the date, or null when it cannot be read
 */
export function parseDirectoryDate(raw: AttributeValue): Date | null {
  const text = String(raw).trim();
  const generalized =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,](\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text
    );
  if (!generalized) {
    const parsed = new Date(text);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, y, mo, d, h, mi, s, fraction, zone] = generalized;
  // Seconds without minutes cannot be told from minutes: the regex fills the
  // minutes first, so a lone pair is always read as minutes.
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(
    v => (v === undefined ? 0 : Number(v))
  );
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60)
    return null;
  // Date.UTC() reads a year below 100 as 19xx, and setUTCFullYear() over a
  // zeroed date re-reads the normalized day and month, so the day is checked
  // once it has been set, before the hour: a leap second (RFC 4517 allows
  // 60) then carries over to the next day instead of failing the check.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  date.setUTCHours(hour, minute, second);
  let time = date.getTime();

  if (fraction !== undefined) {
    const unit = s !== undefined ? 1000 : mi !== undefined ? 60000 : 3600000;
    time += Math.round(Number(`0.${fraction}`) * unit);
  }

  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    const sign = zone[0] === '-' ? -1 : 1;
    time -= sign * (offsetHours * 60 + offsetMinutes) * 60000;
  }
  return new Date(time);
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
