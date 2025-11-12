import Plugin from '../../../dist/abstract/plugin.js';
import {
  asyncHandler,
  BadRequestError,
  NotFoundError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
} from '../../../dist/bin/index.js';

class ErrorTestPlugin extends Plugin {
  name = 'errortest';

  api(app) {
    // Route without asyncHandler - would crash without error middleware
    app.get('/api/error-unhandled', async (req, res) => {
      throw new Error('Unhandled async error');
    });

    // Route with asyncHandler - properly handled
    app.get(
      '/api/error-handled',
      asyncHandler(async (req, res) => {
        throw new Error('Handled async error');
      })
    );

    // Route that throws BadRequestError (400)
    app.get(
      '/api/error-badrequest',
      asyncHandler(async (req, res) => {
        throw new BadRequestError('Invalid request parameter');
      })
    );

    // Route that throws NotFoundError (404)
    app.get(
      '/api/error-notfound',
      asyncHandler(async (req, res) => {
        throw new NotFoundError('Resource not found');
      })
    );

    // Route that throws BadGatewayError (502)
    app.get(
      '/api/error-badgateway',
      asyncHandler(async (req, res) => {
        throw new BadGatewayError('Upstream service failed');
      })
    );

    // Route that throws ServiceUnavailableError (503)
    app.get(
      '/api/error-serviceunavailable',
      asyncHandler(async (req, res) => {
        throw new ServiceUnavailableError('Service temporarily unavailable');
      })
    );

    // Route that throws GatewayTimeoutError (504)
    app.get(
      '/api/error-gatewaytimeout',
      asyncHandler(async (req, res) => {
        throw new GatewayTimeoutError('Upstream timeout');
      })
    );

    // Route that works - to test server is still alive after errors
    app.get(
      '/api/ok',
      asyncHandler(async (req, res) => {
        res.json({ status: 'ok' });
      })
    );
  }
}

export { ErrorTestPlugin as default };
