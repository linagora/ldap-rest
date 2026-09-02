/**
 * @module plugins/scim/errors
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM 2.0 error envelope (RFC 7644 §3.12) and async handler wrapper.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { HttpError } from '../../lib/errors';

import {
  type ScimErrorResponse,
  type ScimErrorType,
  SCHEMA_ERROR,
} from './types';

export const SCIM_CONTENT_TYPE = 'application/scim+json';

export class ScimError extends HttpError {
  scimType?: ScimErrorType;
  constructor(status: number, detail: string, scimType?: ScimErrorType) {
    super(detail, status);
    this.name = 'ScimError';
    this.scimType = scimType;
  }
}

export const scimInvalidFilter = (detail = 'Invalid filter'): ScimError =>
  new ScimError(400, detail, 'invalidFilter');
export const scimInvalidPath = (detail = 'Invalid path'): ScimError =>
  new ScimError(400, detail, 'invalidPath');
export const scimInvalidValue = (detail = 'Invalid value'): ScimError =>
  new ScimError(400, detail, 'invalidValue');
export const scimInvalidSyntax = (detail = 'Invalid syntax'): ScimError =>
  new ScimError(400, detail, 'invalidSyntax');
export const scimNoTarget = (detail = 'No target'): ScimError =>
  new ScimError(400, detail, 'noTarget');
export const scimMutability = (detail = 'Immutable attribute'): ScimError =>
  new ScimError(400, detail, 'mutability');
export const scimUniqueness = (detail = 'Uniqueness violation'): ScimError =>
  new ScimError(409, detail, 'uniqueness');
export const scimTooMany = (detail = 'Too many results'): ScimError =>
  new ScimError(400, detail, 'tooMany');
export const scimNotFound = (detail = 'Resource not found'): ScimError =>
  new ScimError(404, detail);

export function writeScimError(
  res: Response,
  status: number,
  detail: string,
  scimType?: ScimErrorType
): void {
  const body: ScimErrorResponse = {
    schemas: [SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
  res.status(status).type(SCIM_CONTENT_TYPE).json(body);
}

/**
 * Extract an LDAP numeric error code from either a thrown ldapts error
 * (has `.code`) or an Error wrapped by ldapActions (message contains the
 * original text). Returns undefined if no code is detectable.
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
  if (/sizeLimitExceeded|Size Limit Exceeded/i.test(msg)) return 4;
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
 * Turn any thrown thing into the SCIM error body it deserves.
 *
 * Split out from `writeScimErrorFromException` so `/Bulk`, which reports a
 * status per operation instead of writing a response, applies exactly the
 * same translations — including the ones that matter: an authorization
 * refusal is a 403 with the internal marker stripped, not a 500 quoting it.
 */
export function scimErrorFromException(
  err: unknown,
  fallbackStatus = 500
): ScimErrorResponse {
  // Authz plugins (e.g. core/auth/authzDynamic) embed a `[authz-forbidden]`
  // marker in the thrown message so a 403 can be recognised even after
  // intermediate callers wrap the error. Strip the marker before emitting
  // a client-facing message so the internal token never leaks.
  const sanitize = (s: string): string =>
    /\[authz-forbidden\]/.test(s)
      ? 'Token does not have permission on this branch'
      : s;
  const body = (
    status: number,
    detail: string,
    scimType?: ScimErrorType
  ): ScimErrorResponse => ({
    schemas: [SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });

  if (err instanceof ScimError) {
    return body(err.statusCode, sanitize(err.message), err.scimType);
  }
  if (err instanceof HttpError) {
    return body(err.statusCode, sanitize(err.message));
  }
  const message = err instanceof Error ? err.message : String(err);
  // Wrapped authz-forbidden (no HttpError instance but marker is in the msg)
  if (/\[authz-forbidden\]/.test(message)) {
    return body(403, 'Token does not have permission on this branch');
  }
  const ldapCode = extractLdapCode(err);
  if (ldapCode === 32) return body(404, 'Resource not found');
  if (ldapCode === 68) return body(409, sanitize(message), 'uniqueness');
  // The directory rejected the write against its schema. Almost always a
  // configuration mistake rather than a bad request — most often the lock
  // attribute backing `active`, whose default needs the ppolicy overlay —
  // so name the cause instead of answering a bare 500.
  if (ldapCode === 17 || ldapCode === 65) {
    return body(
      400,
      `The directory rejected this write against its schema: ${sanitize(
        message
      )}. If it names the attribute backing 'active', that attribute is not in ` +
        `the directory's schema — the default needs the ppolicy overlay; see ` +
        `--scim-user-lock-attribute.`,
      'invalidValue'
    );
  }
  return body(fallbackStatus, sanitize(message) || 'Internal error');
}

export function writeScimErrorFromException(
  res: Response,
  err: unknown,
  fallbackStatus = 500
): void {
  const body = scimErrorFromException(err, fallbackStatus);
  res.status(Number(body.status)).type(SCIM_CONTENT_TYPE).json(body);
}

/**
 * Express wrapper that catches errors, serializes them as SCIM
 * envelope and short-circuits the default Express error middleware.
 * Accepts both sync and async handlers.
 */
export const scimAsyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => void | Promise<void>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(err => {
        if (!res.headersSent) {
          writeScimErrorFromException(res, err);
        } else {
          next(err);
        }
      });
  };
};
