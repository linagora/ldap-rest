import type { Request, Response } from 'express';

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

const _rejectResponse = (
  code: number,
  res: Response,
  message: string
): void => {
  res.status(code).json({ error: message });
};

export const serverError = (res: Response, err: unknown): void => {
  console.error(err);
  res.status(500).json({ error: 'check logs' });
};

export const notFound = (res: Response, message = 'Not found'): void =>
  _rejectResponse(404, res, message);
export const badRequest = (res: Response, message = 'Bad request'): void =>
  _rejectResponse(400, res, message);
export const unauthorized = (res: Response, message = 'Unauthorized'): void =>
  _rejectResponse(401, res, message);
export const forbidden = (res: Response, message = 'Forbidden'): void =>
  _rejectResponse(403, res, message);
export const conflict = (res: Response, message = 'Conflict'): void =>
  _rejectResponse(409, res, message);

export const created = (res: Response, data?: object): void => {
  res.status(201).json(data);
};

export const ok = (res: Response, data: object = { success: true }): void => {
  res.status(200).json(data);
};

export const noContent = (res: Response): void => {
  res.status(204).send();
};

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
