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
