import { expect } from 'chai';
import supertest from 'supertest';
import { DM } from '../../src/bin';

describe('Plugin Override', () => {
  let dm: DM;
  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_PLUGINS =
      '../../dist/plugins/demo/helloworld.js;../../dist/plugins/demo/helloworld.js:myHello:{"api_prefix":"/myapi"}';
    dm = new DM();
    await dm.ready;
  });

  it('should load the helloworld plugin and respond to /api/hello', async () => {
    const request = supertest(dm.app);
    const res = await request.get('/api/hello');
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
  });

  it('should load the helloworld plugin and respond to /myapi/hello', async () => {
    const request = supertest(dm.app);
    const res = await request.get('/myapi/hello');
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
  });

  it('should hand the overridden plugin a usable server', () => {
    // A configuration override used to be applied by spreading the server,
    // which dropped its prototype: the plugin got an object carrying the
    // data but none of the methods, so `this.server.anything()` threw — and
    // only in that configuration
    const plugin = dm.loadedPlugins.myHello;
    expect(plugin, 'overridden plugin').to.not.equal(undefined);
    expect(plugin.server).to.be.instanceOf(DM);
    expect(plugin.server.claimedAuthPrefixes()).to.deep.equal([]);
    expect(plugin.server.registerPlugin).to.be.a('function');
  });

  it('should share everything but the configuration with the server', () => {
    const plugin = dm.loadedPlugins.myHello;
    expect(plugin.server.app).to.equal(dm.app);
    expect(plugin.server.hooks).to.equal(dm.hooks);
    expect(plugin.server.loadedPlugins).to.equal(dm.loadedPlugins);
    expect(plugin.server.config).to.not.equal(dm.config);
    expect(plugin.server.config.api_prefix).to.equal('/myapi');
    expect(dm.config.api_prefix).to.equal('/api');
  });

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PLUGINS;
  });
});
