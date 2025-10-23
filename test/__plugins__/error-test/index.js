import Plugin from '../../../dist/abstract/plugin.js';
import { asyncHandler } from '../../../dist/bin/index.js';

class ErrorTestPlugin extends Plugin {
  name = 'errortest';

  api(app) {
    // Route without asyncHandler - would crash without error middleware
    app.get('/api/error-unhandled', async (req, res) => {
      throw new Error('Unhandled async error');
    });

    // Route with asyncHandler - properly handled
    app.get('/api/error-handled', asyncHandler(async (req, res) => {
      throw new Error('Handled async error');
    }));

    // Route that works - to test server is still alive after errors
    app.get('/api/ok', asyncHandler(async (req, res) => {
      res.json({ status: 'ok' });
    }));
  }
}

export { ErrorTestPlugin as default };
