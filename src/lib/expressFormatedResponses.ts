/**
 * @file src/lib/expressFormatedResponses.ts
 * @description Standard express responses and express utilities
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Request, Response } from 'express';

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

/**
 * Standard API responses with default message
 */

const _rejectResponse = (
  code: number,
  res: Response,
  message: string
): void => {
  res.status(code).json({ error: message });
};

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

// We don't want to publish the real error in server responses
export const serverError = (res: Response, err: unknown): void => {
  console.error(err);
  res.status(500).json({ error: 'check logs' });
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
