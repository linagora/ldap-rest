import { expect } from 'chai';
import request from 'supertest';
import { DM } from '../src/bin/index';
import { serverErrorBody, setDebug } from '../src/lib/expressFormatedResponses';
import { AUTHZ_REFUSED } from '../src/lib/errors';

describe('Error Handling', () => {
  let server: DM | null;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_PORT = '64323';
    process.env.DM_PLUGINS = '../../test/__plugins__/error-test/index.js';
    // @ts-ignore
    server = new DM();
    await server.ready;
    await server.run();
  });

  it('should handle async errors with asyncHandler and return 500', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-handled'
    );
    expect(res.status).to.equal(500);
    expect(res.body).to.deep.equal({
      error: 'Internal Server Error',
      message: 'An error occurred',
    });
  });

  it('should handle unhandled async errors via error middleware and return 500', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-unhandled'
    );
    expect(res.status).to.equal(500);
    expect(res.body).to.have.property('error');
  });

  it('should keep server alive after errors', async () => {
    // Trigger an error
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-handled'
    );

    // Server should still respond to valid requests
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/ok'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
  });

  it('should keep server alive after multiple errors', async () => {
    // Trigger multiple errors
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-handled'
    );
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-unhandled'
    );
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-handled'
    );

    // Server should still respond to valid requests
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/ok'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
  });

  it('should return 400 for BadRequestError with error message', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-badrequest'
    );
    expect(res.status).to.equal(400);
    expect(res.body).to.have.property('error');
    expect(res.body.error).to.equal('Invalid request parameter');
  });

  it('should return 404 for NotFoundError with error message', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-notfound'
    );
    expect(res.status).to.equal(404);
    expect(res.body).to.have.property('error');
    expect(res.body.error).to.equal('Resource not found');
  });

  it('should keep the 403 of a refusal wrapped as a cause, without naming the branch', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-wrapped-refusal'
    );
    expect(res.status).to.equal(403);
    expect(res.body).to.deep.equal({
      error: AUTHZ_REFUSED,
      code: 'forbidden',
    });
  });

  it('should keep the status of an error wrapped as a cause', async () => {
    const port = process.env.DM_PORT;
    const notFound = await request(`http://localhost:${port}`).get(
      '/api/error-wrapped-notfound'
    );
    expect(notFound.status).to.equal(404);
    // The status comes from the chain; the sentence is the route's, which is
    // the one that knows what the request was about.
    expect(notFound.body).to.deep.equal({
      error: 'Failed to read it: NotFoundError: Resource not found',
    });

    const timeout = await request(`http://localhost:${port}`).get(
      '/api/error-wrapped-timeout'
    );
    expect(timeout.status).to.equal(504);
    expect(timeout.body).to.deep.equal({
      error: 'Internal Server Error',
      message: 'An error occurred',
    });
  });

  it('should keep server alive after client errors', async () => {
    // Trigger client errors
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-badrequest'
    );
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-notfound'
    );

    // Server should still respond to valid requests
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/ok'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
  });

  it('should return 502 for BadGatewayError and hide error message', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-badgateway'
    );
    expect(res.status).to.equal(502);
    expect(res.body).to.have.property('error');
    expect(res.body.error).to.equal('Internal Server Error');
  });

  it('should return 503 for ServiceUnavailableError and hide error message', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-serviceunavailable'
    );
    expect(res.status).to.equal(503);
    expect(res.body).to.have.property('error');
    expect(res.body.error).to.equal('Internal Server Error');
  });

  it('should return 504 for GatewayTimeoutError and hide error message', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-gatewaytimeout'
    );
    expect(res.status).to.equal(504);
    expect(res.body).to.have.property('error');
    expect(res.body.error).to.equal('Internal Server Error');
  });

  it('should keep server alive after server errors', async () => {
    // Trigger server errors
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-badgateway'
    );
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-serviceunavailable'
    );
    await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/error-gatewaytimeout'
    );

    // Server should still respond to valid requests
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/ok'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
  });

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PORT;
    delete process.env.DM_PLUGINS;
    server?.stop();
  });

  describe('under --debug', () => {
    let debugServer: DM;
    const previous = process.env.DM_DEBUG;

    before(async () => {
      process.env.DM_DEBUG = 'true';
      try {
        debugServer = new DM();
      } finally {
        if (previous === undefined) delete process.env.DM_DEBUG;
        else process.env.DM_DEBUG = previous;
      }
      await debugServer.ready;
      debugServer.app.get('/boom', () => {
        throw new Error('the directory is down');
      });
      debugServer.setupErrorMiddleware();
    });

    after(() => {
      debugServer?.stop();
      setDebug(false);
    });

    it('names the failure on both paths', async () => {
      expect(debugServer.config.debug).to.equal(true);
      const err = new Error('the directory is down');
      expect(serverErrorBody(err)).to.deep.equal({
        error: 'Internal Server Error',
        message: 'the directory is down',
      });
      // The middleware reads its own server's flag, not the module default
      setDebug(false);
      const res = await request(debugServer.app).get('/boom');
      expect(res.status).to.equal(500);
      expect(res.body).to.deep.equal({
        error: 'Internal Server Error',
        message: 'the directory is down',
      });
      expect(serverErrorBody(err)).to.deep.equal({
        error: 'Internal Server Error',
        message: 'An error occurred',
      });
    });
  });
});
