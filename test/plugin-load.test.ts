import { expect } from 'chai';
import request from 'supertest';

describe('Plugin Loading', () => {
  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_PORT = '64321';
    process.env.DM_PLUGINS = 'core/helloworld';
    await import('../dist/bin/index.js');
  });

  it('should load the helloworld plugin and respond to /hello', async () => {
    const res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/hello'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello' });
  });

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PORT;
    delete process.env.DM_PLUGINS;
  });
});
