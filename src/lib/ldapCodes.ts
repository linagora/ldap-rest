/**
 * @module lib/ldapCodes
 *
 * Reading an LDAP result code off a thrown error.
 *
 * Callers have to tell one failure from another — noSuchObject from
 * entryAlreadyExists, a size limit from a server fault — and the code is the
 * only part of a failure the protocol defines. The wording is the driver's,
 * and no driver promises to keep it.
 *
 * This lived in `plugins/scim/errors` until an LDAP plugin needed it too;
 * nothing in it is SCIM's business, so it is here and SCIM re-exports it.
 *
 * @group Libraries
 */

/**
 * Extract an LDAP numeric error code from a thrown ldapts error.
 *
 * `.code` first: ldapts sets it, and `ldapActions` carries it across its own
 * wrapping rather than reducing the failure to a sentence. The message
 * patterns below stay as a fallback for the paths that still throw a bare
 * `Error` — they are why a driver that reworded its messages could quietly
 * turn a 400 into a 500, so they are the last resort, not the first.
 *
 * @param err whatever was thrown
 * @returns the LDAP result code, or undefined when nothing says
 */
export function extractLdapCode(err: unknown): number | undefined {
  if (err == null) return undefined;
  if (typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/noSuchObject|No such object|code:?\s*(32|0x20)/i.test(msg)) return 32;
  if (/entryAlreadyExists|Already[_ ]?Exists|code:?\s*(68|0x44)/i.test(msg))
    return 68;
  if (/noSuchAttribute|No such attribute|code:?\s*(16|0x10)/i.test(msg))
    return 16;
  if (/sizeLimitExceeded|Size Limit Exceeded|code:?\s*(4|0x4)\b/i.test(msg))
    return 4;
  if (
    /undefinedAttributeType|Undefined attribute type|code:?\s*(17|0x11)/i.test(
      msg
    )
  )
    return 17;
  if (
    /objectClassViolation|Object Class Violation|code:?\s*(65|0x41)/i.test(msg)
  )
    return 65;
  return undefined;
}

/**
 * Result codes by which the directory refuses a write for what it asks
 * (RFC 4511 appendix A): an attribute or class its schema does not define or
 * allow there, a value it cannot match or whose syntax is wrong, a broken
 * constraint, a DN it cannot name. The request is at fault, not the server.
 *
 * attributeOrValueExists (20) is not here: on a modify it says what the
 * entry already holds rather than what the request asks, and `ldapActions`
 * maps it per operation.
 */
const SCHEMA_REFUSALS: ReadonlySet<number> = new Set([
  17, // undefinedAttributeType
  18, // inappropriateMatching
  19, // constraintViolation
  21, // invalidAttributeSyntax
  34, // invalidDNSyntax
  64, // namingViolation
  65, // objectClassViolation
  67, // notAllowedOnRDN
  69, // objectClassModsProhibited
]);

/**
 * Whether an LDAP result code means the directory refused the request for
 * its content, see {@link SCHEMA_REFUSALS}.
 *
 * @param code LDAP result code, as {@link extractLdapCode} reads it
 */
export const isSchemaRefusal = (code: number | undefined): boolean =>
  code !== undefined && SCHEMA_REFUSALS.has(code);

/**
 * Most bytes of an RDN back-mdb can key. Measured on osixia/openldap 1.5: an
 * RDN of 245 bytes stores and one of 246 answers `other` (80), whatever its
 * type, counted in UTF-8 bytes of the RDN as written, escaping included. The
 * limit is on the RDN alone: a deep DN whose RDN is short stores.
 */
export const RDN_KEY_LIMIT = 245;

/**
 * Longest RDN whose `other` (80) stays the server's failure. A backend that
 * cannot key an RDN answers 80 without a diagnostic, so its length is the
 * only clue. The margin below {@link RDN_KEY_LIMIT} covers a backend or a
 * version keying less; it is also the window where an unrelated 80 (a full
 * database, an index failure) on an RDN that long is reported as the
 * client's fault, the price of a 400 rather than a 500 for the common case.
 */
export const LONG_RDN = 200;

/**
 * Whether an LDAP result code means the directory could not key `rdn`: an
 * `other` (80) on an RDN longer than {@link LONG_RDN} bytes. The request is
 * at fault, as for {@link isSchemaRefusal}; each caller says it in its own
 * words.
 *
 * @param rdn the RDN as written in the DN sent, escaping included
 * @param code LDAP result code, as {@link extractLdapCode} reads it
 */
export const isUnstorableRdn = (
  rdn: string,
  code: number | undefined
): boolean => code === 80 && Buffer.byteLength(rdn, 'utf8') > LONG_RDN;
