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
  const refusal = errorChain(err).find(e => e instanceof HttpError)?.refusal;
  return refusal ? { error: message, ...refusal } : { error: message };
};

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * An authorization plugin's refusal.
 *
 * Its message is for the operator, not for the client: it names the model
 * and the branch it judged, which the caller may not know of. Its class is
 * what says an authorization plugin refused, so the 403 is recognised
 * through the `new Error(\`…\`, { cause })` wrappers along the way — see
 * {@link isAuthzRefusal} — and the client is told {@link AUTHZ_REFUSED}.
 */
export class AuthzRefusedError extends ForbiddenError {
  /**
   * Read instead of the class and the name: a plugin loaded from `dist` holds
   * another copy of this module, where `instanceof` answers false, and a
   * subclass may replace `name`.
   */
  readonly authzRefusal = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'AuthzRefusedError';
  }
}

/** How far a chain of `cause`s is followed before it is taken as a loop. */
const CAUSE_DEPTH = 32;

/**
 * Every error in a chain of `cause`s, the outermost first.
 *
 * A plugin wrapping what the directory or an authorization hook threw as
 * `new Error(\`…\`, { cause: err })` keeps the reason and what it carries:
 * its class, its status, the database's refusal. The serializers read the
 * whole chain rather than the wrapper alone.
 *
 * @param err what was thrown, which need not be an error
 * @returns the errors of the chain, the outermost first
 */
export const errorChain = (err: unknown): Error[] => {
  const chain: Error[] = [];
  let current: unknown = err;
  while (current instanceof Error && !chain.includes(current)) {
    chain.push(current);
    if (chain.length === CAUSE_DEPTH) break;
    current = current.cause;
  }
  return chain;
};

/**
 * Whether an error is, or wraps through `cause`, an authorization plugin's
 * refusal.
 *
 * Read by the `authzRefusal` marker rather than by class: a plugin loaded
 * from `dist` while its caller runs from `src` throws a `AuthzRefusedError`
 * whose `instanceof` answers false, and a subclass that replaces `name`
 * would escape a name test — the refusal would then be answered as the
 * wrapper's own error.
 *
 * @param err what was thrown
 * @returns true for a refusal, or for an error wrapping one
 */
export const isAuthzRefusal = (err: unknown): boolean =>
  errorChain(err).some(
    e => (e as { authzRefusal?: unknown }).authzRefusal === true
  );

/**
 * The status a thrown thing is answered with.
 *
 * The first error from the outside that names one decides: a wrapper names
 * none, so the error it wraps is read; a layer that translates an inner error
 * keeps its own status. `statusCode` is the convention of this module, while
 * Express's router sets `status` alone on the errors it throws.
 *
 * @param err what was thrown
 * @returns its status code, 500 when it names none
 */
export const statusCodeOf = (err: unknown): number => {
  for (const error of errorChain(err)) {
    const { statusCode, status } = error as {
      statusCode?: unknown;
      status?: unknown;
    };
    if (typeof statusCode === 'number') return statusCode;
    if (typeof status === 'number' && status >= 400 && status < 600)
      return status;
  }
  return 500;
};

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
export class AmbiguousIdentityError extends AuthzRefusedError {
  constructor(
    public identity: string,
    public count: number
  ) {
    super(
      `${identity} names ${count} directory entries, ` +
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
