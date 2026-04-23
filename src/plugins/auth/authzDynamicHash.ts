/**
 * @module plugins/auth/authzDynamicHash
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Verify bearer tokens against LDAP `userPassword` hashes.
 *
 * Supported RFC 3112 schemes:
 *   {SSHA}    — salted SHA-1     (OpenLDAP default)
 *   {SHA}     — unsalted SHA-1
 *   {SSHA256} — salted SHA-256
 *   {SHA256}  — unsalted SHA-256
 *   {SSHA512} — salted SHA-512
 *   {SHA512}  — unsalted SHA-512
 *   {MD5}     — unsalted MD5     (legacy, not recommended)
 *   {SMD5}    — salted MD5       (legacy, not recommended)
 *   {CLEARTEXT} / no prefix      — cleartext (test environments only)
 *
 * All comparisons use `crypto.timingSafeEqual` / `timingSafeStringEqual`
 * to prevent timing side-channels on the secret.
 */
import crypto from 'crypto';

const HASH_LENGTHS: Record<string, number> = {
  sha1: 20,
  sha256: 32,
  sha512: 64,
  md5: 16,
};

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySalted(
  algo: 'sha1' | 'sha256' | 'sha512' | 'md5',
  payload: string,
  password: string
): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(payload, 'base64');
  } catch {
    return false;
  }
  const digestLen = HASH_LENGTHS[algo];
  if (decoded.length <= digestLen) return false;
  const storedHash = decoded.subarray(0, digestLen);
  const salt = decoded.subarray(digestLen);
  const computed = crypto
    .createHash(algo)
    .update(Buffer.from(password, 'utf8'))
    .update(salt)
    .digest();
  if (computed.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(storedHash, computed);
}

function verifyUnsalted(
  algo: 'sha1' | 'sha256' | 'sha512' | 'md5',
  payload: string,
  password: string
): boolean {
  const computed = crypto
    .createHash(algo)
    .update(Buffer.from(password, 'utf8'))
    .digest('base64');
  return timingSafeStringEqual(payload, computed);
}

/**
 * Verify a provided bearer token against a stored LDAP-style hash.
 *
 * The stored hash is typically the contents of `userPassword`:
 * either `{SCHEME}<data>` or cleartext.
 */
export function verifyLdapPassword(provided: string, stored: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof stored !== 'string' || stored.length === 0) return false;

  const m = /^\{([A-Za-z0-9-]+)\}(.*)$/.exec(stored);
  if (!m) {
    // No scheme prefix → treat as cleartext
    return timingSafeStringEqual(provided, stored);
  }
  const scheme = m[1].toUpperCase();
  const payload = m[2];

  switch (scheme) {
    case 'SSHA':
      return verifySalted('sha1', payload, provided);
    case 'SHA':
      return verifyUnsalted('sha1', payload, provided);
    case 'SSHA256':
      return verifySalted('sha256', payload, provided);
    case 'SHA256':
      return verifyUnsalted('sha256', payload, provided);
    case 'SSHA512':
      return verifySalted('sha512', payload, provided);
    case 'SHA512':
      return verifyUnsalted('sha512', payload, provided);
    case 'SMD5':
      return verifySalted('md5', payload, provided);
    case 'MD5':
      return verifyUnsalted('md5', payload, provided);
    case 'CLEARTEXT':
    case 'PLAIN':
      return timingSafeStringEqual(provided, payload);
    default:
      // Unknown scheme: refuse authentication rather than risk a silent match.
      return false;
  }
}

/**
 * Convenience helper for tests / tooling to generate an {SSHA} hash.
 * NOT used by runtime verification.
 */
export function ssha(password: string, salt?: Buffer): string {
  const s = salt || crypto.randomBytes(8);
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.from(password, 'utf8'))
    .update(s)
    .digest();
  return `{SSHA}${Buffer.concat([digest, s]).toString('base64')}`;
}
