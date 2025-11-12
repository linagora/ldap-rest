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
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'HttpError';
  }
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

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Conflict') {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

export class UriTooLongError extends HttpError {
  constructor(message = 'URI Too Long') {
    super(message, 414);
    this.name = 'UriTooLongError';
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
