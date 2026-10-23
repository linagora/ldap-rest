/**
 * Custom HTTP Error classes with status codes
 * @author Xavier Guimard <xguimard@linagora.com>
 */

/**
 * Base HTTP Error class with status code
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public refusal?: Refusal
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * What a client is told of a refusal besides its sentence: enough to say it
 * in its own language and next to the field at fault, without reading the
 * sentence back. Added to the `error` field of the answer, never in place
 * of it.
 */
export interface Refusal {
  /**
   * `unique` (a value already used), `mailDomain` (an address outside the
   * authorised domains) or `forbidden` (an authorization plugin refused)
   */
  code: 'unique' | 'mailDomain' | 'forbidden';
  /** The attribute refused */
  attribute?: string;
  /** The value refused */
  value?: string;
  /** The authorised mail domains, for `mailDomain` */
  domains?: string[];
}

/**
 * Client errors (4xx)
 */
export class BadRequestError extends HttpError {
  constructor(message = 'Bad request') {
    super(message, 400);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

/**
 * What a client is told of an authorization refusal: the message the plugin
 * threw names the branch, which the caller may not know of.
 */
export const AUTHZ_REFUSED = 'Token does not have permission on this branch';

/**
 * The JSON answer of a client error: its sentence, and the refusal it
 * carries. An authorization plugin's refusal carries none — its message names
 * the branch, which is why the client is told `AUTHZ_REFUSED` — so the code
 * is given here, from the sentence the caller settled on.
 *
 * @param err the error thrown
 * @param message the sentence the client is told
 * @returns the body to answer
 */
export const errorBody = (
  err: unknown,
  message: string
): { error: string } & Partial<Refusal> => {
  if (message === AUTHZ_REFUSED) return { error: message, code: 'forbidden' };
  const refusal = err instanceof HttpError ? err.refusal : undefined;
  return refusal ? { error: message, ...refusal } : { error: message };
};

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * An identity that names more than one directory entry.
 *
 * A `uid` (or whatever `--ldap-user-main-attribute` names) is only unique if
 * the directory enforces it, which OpenLDAP does not by default. Taking the
 * first entry would hand the caller whichever one the server happens to list
 * first — and with it that entry's groups or organizations. It is a refusal
 * rather than a `null`: a `null` resolution is what
 * `--authz-unresolved-user allow` lets through unchecked.
 */
export class AmbiguousIdentityError extends ForbiddenError {
  constructor(
    public identity: string,
    public count: number
  ) {
    super(
      `[authz-forbidden] ${identity} names ${count} directory entries, ` +
        'so no single one can be taken for the caller'
    );
    this.name = 'AmbiguousIdentityError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Conflict', refusal?: Refusal) {
    super(message, 409, refusal);
    this.name = 'ConflictError';
  }
}

export class UriTooLongError extends HttpError {
  constructor(message = 'URI Too Long') {
    super(message, 414);
    this.name = 'UriTooLongError';
  }
}

export class UnprocessableEntityError extends HttpError {
  constructor(message = 'Unprocessable Entity') {
    super(message, 422);
    this.name = 'UnprocessableEntityError';
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message = 'Too Many Requests') {
    super(message, 429);
    this.name = 'TooManyRequestsError';
  }
}

/**
 * Server errors (5xx)
 */
export class BadGatewayError extends HttpError {
  constructor(message = 'Bad Gateway') {
    super(message, 502);
    this.name = 'BadGatewayError';
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message = 'Service Unavailable') {
    super(message, 503);
    this.name = 'ServiceUnavailableError';
  }
}

export class GatewayTimeoutError extends HttpError {
  constructor(message = 'Gateway Timeout') {
    super(message, 504);
    this.name = 'GatewayTimeoutError';
  }
}
