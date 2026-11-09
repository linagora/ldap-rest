/**
 * Errors and value checks shared by the LDAP operation pipeline.
 */
import type { SearchResult } from 'ldapts';

import { getParentDn } from '../utils.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { extractLdapCode, isSchemaRefusal } from '../ldapCodes.js';

// Code

/**
 * Wrap a driver error without losing its LDAP result code.
 *
 * These methods re-throw their own `Error` so the message says which
 * operation failed. That used to leave the numeric code — the only
 * dependable way for a caller to tell noSuchObject from
 * entryAlreadyExists, or a schema refusal from a server fault — recoverable
 * only by matching the driver's wording, which no driver promises to keep.
 * `Error.cause` would be the idiomatic home for it, but it is not in this
 * project's `lib` target; the code itself is what callers read, as
 * `extractLdapCode` finds it, message patterns included.
 */
export function ldapError(context: string, error: unknown): Error {
  const wrapped = new Error(`${context}: ${String(error)}`);
  const code = extractLdapCode(error);
  return code === undefined ? wrapped : withCode(wrapped, code);
}

export function withCode<T extends Error>(err: T, code: number): T {
  (err as { code?: number }).code = code;
  return err;
}

/**
 * ldapts gives every requested attribute the entry lacks an empty list, so
 * the `*`, `+` and `1.1` selectors came back as attributes of their own.
 */
const SELECTORS = ['*', '+', '1.1'];
export const dropSelectors = (result: SearchResult): SearchResult => {
  for (const entry of result.searchEntries)
    for (const name of SELECTORS) {
      const value = (entry as Record<string, unknown>)[name];
      if (Array.isArray(value) && value.length === 0)
        delete (entry as Record<string, unknown>)[name];
    }
  return result;
};
export async function* dropSelectorsPaged(
  pages: AsyncGenerator<SearchResult>
): AsyncGenerator<SearchResult> {
  for await (const page of pages) yield dropSelectors(page);
}

/**
 * A 400 for a write the directory refused for what it asks, carrying the
 * LDAP code for callers that map it themselves.
 *
 * The client is told the directory's diagnostic, which names the attribute
 * at fault ("mailQuota: attribute type undefined"), not the value sent.
 */
export function ldapRefusal(what: string, code: number, error: unknown): Error {
  return withCode(new BadRequestError(`${what}: ${String(error)}`), code);
}

/**
 * No value adds nothing: an empty list is a protocol error for the directory,
 * and ldapts throws on `null` or `undefined`, alone or in a list. Either
 * reached the client as a 500. A replace with no value is how an attribute is
 * cleared, and does not come here.
 */
const unwritable = (value: unknown): boolean => {
  const absent = (v: unknown): boolean => v === null || v === undefined;
  if (Array.isArray(value))
    return value.length === 0 || value.some(item => absent(item));
  return absent(value);
};

export function assertHasValue(name: string, value: unknown): void {
  if (unwritable(value))
    throw new BadRequestError(`Attribute "${name}" has no value`);
}

/**
 * Wrap a write failure, turning a refusal of the request's content (see
 * `isSchemaRefusal`) into a 400: the mistake is the client's, and a 500
 * would hide it in logs it cannot read.
 */
export function ldapWriteError(
  context: string,
  dn: string,
  error: unknown
): Error {
  const code = extractLdapCode(error);
  return isSchemaRefusal(code)
    ? ldapRefusal(`The directory refused this write to ${dn}`, code!, error)
    : ldapError(context, error);
}

/**
 * Wrap a read failure, turning a refusal of the request's content (see
 * `isSchemaRefusal`) into a 400: the mistake is the client's, and a 500
 * would hide it in logs it cannot read. Any other failure leaves as it was
 * thrown. The base names the subtree read, which a configuration may set.
 */
export function ldapSearchError(base: string, error: unknown): Error {
  const code = extractLdapCode(error);
  if (isSchemaRefusal(code))
    return ldapRefusal(
      `The directory refused this read of ${base}`,
      code!,
      error
    );
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Wrap an add failure, turning entryAlreadyExists (68) into a 409.
 *
 * Every creation route ends here, so this is the one place that knows a
 * duplicate is a conflict: mapped in each caller instead, the flat routes
 * answered 409 while `POST /ldap/groups` and the organization routes turned
 * the same refusal into a 500. The checks callers run look before writing, so
 * two creations of the same entry sent at once both pass them and the
 * directory refuses the second — a bulk import whose file holds one person
 * twice does exactly that. That is a conflict, not a fault.
 *
 * The numeric code is carried over onto the `ConflictError`: callers that
 * read it to recognise a duplicate (SCIM's uniqueness mapping, the
 * idempotent applicative-account creation) keep working unchanged.
 */
export function ldapAddError(dn: string, error: unknown): Error {
  const code = extractLdapCode(error);
  if (code === 68)
    return withCode(new ConflictError(`Entry ${dn} already exists`), code);
  // The branch it goes in: a flat entity's base nothing created yet
  if (code === 32)
    return withCode(
      new NotFoundError(`${getParentDn(dn)} does not exist`),
      code
    );
  // attributeOrValueExists, on an add: the request names a value twice
  if (code === 20)
    return ldapRefusal(
      `The directory refused this write to ${dn}`,
      code,
      error
    );
  return ldapWriteError('LDAP add error', dn, error);
}

/**
 * Wrap a modify failure, turning objectClassViolation (65) and
 * attributeOrValueExists (20) into a 409: the entry is not of a kind that can
 * hold what was written, typically one created by another tool without a
 * class its schema declares, or already holds the value added. A missing
 * entry (32) or value to delete (16) is a 404. The code is carried over for
 * callers that map it themselves.
 */
export function ldapModifyError(dn: string, error: unknown): Error {
  const code = extractLdapCode(error);
  if (code === 32)
    return withCode(new NotFoundError(`Entry ${dn} not found`), code);
  if (code === 16)
    return withCode(
      new NotFoundError(`Entry ${dn} does not hold the value to delete`),
      code
    );
  if (code !== 65 && code !== 20)
    return ldapWriteError('LDAP modify error', dn, error);
  return withCode(
    new ConflictError(`Entry ${dn} cannot hold this change: ${String(error)}`),
    code
  );
}

/**
 * Wrap a rename or move failure: a new DN already taken (68) is a 409, as on
 * an add, and a refusal of the request's content a 400 naming both DNs, the
 * new one being what the directory usually refused.
 */
export function ldapRenameError(
  context: string,
  dn: string,
  newDn: string,
  error: unknown
): Error {
  const code = extractLdapCode(error);
  if (code === 68)
    return withCode(new ConflictError(`Entry ${newDn} already exists`), code);
  return isSchemaRefusal(code)
    ? ldapRefusal(
        `The directory refused to rename ${dn} to ${newDn}`,
        code!,
        error
      )
    : ldapError(context, error);
}
