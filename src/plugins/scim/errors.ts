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
  return undefined;
}

export function writeScimErrorFromException(
  res: Response,
  err: unknown,
  fallbackStatus = 500
): void {
  if (err instanceof ScimError) {
    writeScimError(res, err.statusCode, err.message, err.scimType);
    return;
  }
  if (err instanceof HttpError) {
    writeScimError(res, err.statusCode, err.message);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const ldapCode = extractLdapCode(err);
  if (ldapCode === 32) {
    writeScimError(res, 404, 'Resource not found');
    return;
  }
  if (ldapCode === 68) {
    writeScimError(res, 409, message, 'uniqueness');
    return;
  }
  writeScimError(res, fallbackStatus, message || 'Internal error');
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
