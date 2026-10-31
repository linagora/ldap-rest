/**
 * Standard express responses and express utilities
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { Type } from '@sinclair/typebox';
import type { Request, Response } from 'express';
import type winston from 'winston';

import {
  AUTHZ_REFUSED,
  errorBody,
  isAuthzRefusal,
  statusCodeOf,
  type Refusal,
} from './errors';

/**
 * The server's logger, once the `DM` constructor has installed it.
 *
 * Undefined until then, and said so in the type: this module is loaded
 * before any `DM` exists, and a caller reading it as always there throws
 * from inside the error path it was reporting on (#182, #199). The compiler
 * now holds every reader to a guard.
 */
let _logger: winston.Logger | undefined;

/**
 * Install the logger, or remove it: a test restores the state it found,
 * which before any `DM` is none.
 *
 * @param logger the logger, or undefined for none
 */
export const setLogger = (logger: winston.Logger | undefined): void => {
  _logger = logger;
};

/** @returns the installed logger, or undefined before any `DM` exists */
export const getLogger = (): winston.Logger | undefined => _logger;

let _debug = false;

/**
 * Whether `serverError` names the failure in its answer: the `--debug` of
 * the server, installed as its logger is.
 *
 * @param debug true to name the failure in the response
 */
export const setDebug = (debug: boolean): void => {
  _debug = debug;
};

/**
 * The sentence a client is told of a client error: an authorization
 * plugin's refusal says nothing of the branch it judged.
 *
 * Any other client error keeps the sentence of the outermost error, the one
 * the route threw when it gave up: it says what the caller's request was
 * about, which the `HttpError` several layers down does not.
 *
 * @param err what was thrown
 * @returns the sentence to answer
 */
export const clientMessageOf = (err: unknown): string =>
  isAuthzRefusal(err) ? AUTHZ_REFUSED : messageOf(err);

/**
 * The message of a thrown thing, read the way the log reads it.
 *
 * @param err what was thrown
 * @returns its message, or the value as a string
 */
export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * What an error is answered with, for the error middleware of `DM` and
 * `serverError` alike: one status and one body, wherever the handler called
 * a helper or threw.
 *
 * An authorization plugin's refusal loses its status when a plugin wraps it
 * as a plain `Error`; it is still a 403, whatever the wrapper says. The
 * failure of a 5xx is for the logs, and is named in the body only under
 * `--debug`.
 *
 * @param err what failed
 * @param debug whether to name a failure in the answer
 * @returns the status and body to answer
 */
export const errorResponse = (
  err: unknown,
  debug = _debug
): { status: number; body: { error: string } & Partial<Refusal> } => {
  const refusal = isAuthzRefusal(err);
  const status = refusal ? 403 : statusCodeOf(err);
  if (status >= 400 && status < 500)
    return { status, body: errorBody(err, clientMessageOf(err)) };
  return {
    status,
    body: serverErrorBody(err, debug),
  };
};

/**
 * The body of a 5xx answer, for every status answered when the failure is
 * the server's: the message names the failure only under `--debug`.
 *
 * @param err what failed
 * @param debug whether to name the failure; `serverError`'s setting by default
 */
export const serverErrorBody = (
  err: unknown,
  debug = _debug
): { error: string; message: string } => ({
  error: 'Internal Server Error',
  message: debug ? messageOf(err) : 'An error occurred',
});

// Utility that generates standard responses depending on the success of the method
export const tryMethod = async (
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  method: Function,
  ...args: unknown[]
): Promise<void> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    await method(...args);
    return ok(res);
  } catch (err) {
    return serverError(res, err);
  }
};

export const tryMethodData = async (
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  method: Function,
  ...args: unknown[]
): Promise<void> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const data = await method(...args);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return ok(res, data);
  } catch (err) {
    return serverError(res, err);
  }
};

/**
 * Standard API responses with default message
 */

const _rejectResponse = (
  code: number,
  res: Response,
  message: string
): void => {
  _logger?.warn(`Client error ${code}: ${message}`);
  res.status(code).json({ error: message });
};

/**
 * The answer of a route that changed something and returned nothing: the
 * shape every write route declares as its 200.
 */
export const WriteResponse = Type.Object({ success: Type.Boolean() });

// 20x responses
export const ok = (res: Response, data: object = { success: true }): void => {
  res.status(200).json(data);
};

export const created = (res: Response, data?: object): void => {
  res.status(201).json(data);
};

export const noContent = (res: Response): void => {
  res.status(204).send();
};

/**
 * A request whose parts did not all succeed, and whose failure cannot be
 * undone (RFC 4918 section 13).
 *
 * An entry rename rewrites the references other entries hold to it. The
 * rename itself is the only rollback point: once the directory has accepted
 * it, a reference that could not be rewritten leaves the directory partly
 * inconsistent, and answering 200 would hide it while answering 500 would
 * claim nothing happened. The body says what was done and what was not.
 *
 * @param res express response
 * @param data report of what succeeded and what did not
 */
export const multiStatus = (res: Response, data: object): void => {
  res.status(207).json(data);
};

// 40x responses
export const badRequest = (res: Response, message = 'Bad request'): void =>
  _rejectResponse(400, res, message);
export const unauthorized = (res: Response, message = 'Unauthorized'): void =>
  _rejectResponse(401, res, message);
export const forbidden = (res: Response, message = 'Forbidden'): void =>
  _rejectResponse(403, res, message);
export const notFound = (res: Response, message = 'Not found'): void =>
  _rejectResponse(404, res, message);
export const conflict = (res: Response, message = 'Conflict'): void =>
  _rejectResponse(409, res, message);
export const uriTooLong = (res: Response, message = 'URI Too Long'): void =>
  _rejectResponse(414, res, message);
export const tooManyRequests = (
  res: Response,
  message = 'Too Many Requests'
): void => _rejectResponse(429, res, message);

// 50x responses

// The logger is read guarded, as `_rejectResponse` reads it: `setLogger`
// runs in the `DM` constructor, and anything reaching here without one —
// a library, a test — would otherwise throw `Cannot read properties of
// undefined` from inside the error path, and the response it owes would
// never be sent.
export const serverError = (res: Response, err: unknown): void => {
  const { status, body } = errorResponse(err, _debug);

  if (status < 500) {
    _logger?.warn(`Client error ${status}: ${body.error}`);
    res.status(status).json(body);
    return;
  }

  if (err instanceof Error) {
    _logger?.error(err.message, err);
  } else if (typeof err === 'string') {
    _logger?.error(err);
  } else {
    _logger?.error('Server error', err);
  }
  res.status(status).json(body);
};
export const badGateway = (res: Response, message = 'Bad Gateway'): void =>
  _rejectResponse(502, res, message);
export const serviceUnavailable = (
  res: Response,
  message = 'Service unavailable'
): void => _rejectResponse(503, res, message);
export const gatewayTimeout = (
  res: Response,
  message = 'Gateway Timeout'
): void => _rejectResponse(504, res, message);

// Utilities
export const wantJson = (req: Request, res: Response): boolean => {
  if (req.accepts('json') === false) {
    badRequest(res);
    return false;
  }
  return true;
};

export const jsonBody = (
  req: Request,
  res: Response,
  ...requiredFields: string[]
): object | false => {
  try {
    if (!wantJson(req, res)) return false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = req.body;
    // Express 5 leaves `req.body` undefined when no parser read the request
    // (no JSON content type), and callers take `false` as "already answered".
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      badRequest(res, 'Bad content');
      return false;
    }

    if (requiredFields.length > 0) {
      for (let i = 0; i < requiredFields.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (body[requiredFields[i]] == undefined) {
          badRequest(res, 'Bad content');
          return false;
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return body;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    badRequest(res, 'Bad content');
    return false;
  }
};
