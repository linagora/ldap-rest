import { expect } from 'chai';
import request from 'supertest';
import { DM } from '../src/bin/index';

describe('Plugin Loading', () => {
  let server: DM | null;
  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_PORT = '64322';
    process.env.DM_PLUGINS =
      '../../dist/plugins/helloworld.js,../../test/__plugins__/hello/index.js';
    // @ts-ignore
    server = new DM();
    await server.ready;
    await server.run();
  });

  it('should load the helloworld plugin and respond to /hello', async () => {
    let res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/hello'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
    res = await request(`http://localhost:${process.env.DM_PORT}`).get(
      '/hellopath'
    );
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello path' });

    expect(server?.loadedPlugins.hello).to.be.an('object');
    expect(server?.loadedPlugins.hellopath).to.be.an('object');
  });

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PORT;
    delete process.env.DM_PLUGINS;
    server?.stop();
  });
});
