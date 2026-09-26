import { DM } from '../../../src/bin';
import type { Express, Response } from 'express';
import request from 'supertest';
import AuthFake from '../../../src/plugins/auth/fake';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import type { DmRequest } from '../../../src/lib/auth/base';
import { expect } from 'chai';

describe('AuthFake', () => {
  let savedUser: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedUser = process.env.DM_AUTH_FAKE_USER;
    savedEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedUser === undefined) delete process.env.DM_AUTH_FAKE_USER;
    else process.env.DM_AUTH_FAKE_USER = savedUser;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  });

  it('serves every request as the configured identity', async () => {
    process.env.DM_AUTH_FAKE_USER = 'alice';
    const dm = new DM();
    await dm.ready;
    const plugin = new AuthFake(dm);
    await dm.registerPlugin('authFake', plugin);
    await dm.registerPlugin('helloWorld', new HelloWorld(dm));
    const app: Express = dm.app;

    const res = await request(app).get('/api/hello');
    expect(res.status).to.equal(200);

    const req = {} as DmRequest;
    let passed = false;
    plugin.authMethod(req, {} as Response, () => {
      passed = true;
    });
    expect(passed).to.equal(true);
    expect(req.user).to.equal('alice');
    expect(req.userName).to.equal('alice');
  });

  it('refuses to start without --auth-fake-user', async () => {
    process.env.DM_AUTH_FAKE_USER = '';
    const dm = new DM();
    await dm.ready;
    expect(() => new AuthFake(dm)).to.throw(/--auth-fake-user is required/);
  });

  it('refuses to start with NODE_ENV=production', async () => {
    process.env.DM_AUTH_FAKE_USER = 'alice';
    process.env.NODE_ENV = 'production';
    const dm = new DM();
    await dm.ready;
    expect(() => new AuthFake(dm)).to.throw(/NODE_ENV=production/);
  });
});
