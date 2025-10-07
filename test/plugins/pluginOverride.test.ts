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

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PLUGINS;
  });
});
