import { expect } from 'chai';
import request from 'supertest';
import { DM } from '../../src/bin';

describe('Plugin Override', () => {
  let server: DM | null;
  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_PORT = '64321';
    process.env.DM_PLUGINS =
      '../../dist/plugins/helloworld.js;../../dist/plugins/helloworld.js:myHello:{"api_prefix":"/myapi"}';
    server = new DM();
    await server.ready;
    await server.run();
  });

  it('should load the helloworld plugin and respond to /api/hello', async () => {
    let res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/api/hello'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
  });

  it('should load the helloworld plugin and respond to /myapi/hello', async () => {
    let res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/myapi/hello'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
  });

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PORT;
    delete process.env.DM_PLUGINS;
  });
});
