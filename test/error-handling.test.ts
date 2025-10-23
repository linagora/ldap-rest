import { expect } from 'chai';
import request from 'supertest';
import { DM } from '../src/bin/index';

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
    expect(res.body).to.have.property('error');
    expect(res.body.error).to.equal('Internal Server Error');
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

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PORT;
    delete process.env.DM_PLUGINS;
    server?.stop();
  });
});
