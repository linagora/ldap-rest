import { DM } from '../../../src/bin';
import type { Express } from 'express';
import request from 'supertest';
import AuthToken from '../../../src/plugins/auth/token';
import AuthzPerRoute from '../../../src/plugins/auth/authzPerRoute';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import { expect } from 'chai';

describe('AuthzPerRoute', () => {
  describe('Basic rule enforcement', () => {
    let app: Express;

    before(async () => {
      // full:tok-full → wildcard; updt:tok-updt → GET /api/hello only
      process.env.DM_AUTH_TOKENS = 'tok-full:full,tok-updt:updt';
      process.env.DM_AUTHZ_PER_ROUTE = 'full:*,updt:GET:/api/hello';
      const dm = new DM();
      await dm.ready;
      // Auth must be registered before authz
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTE;
    });

    it('wildcard user can reach /api/hello', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-full');
      expect(res.status).to.equal(200);
    });

    it('restricted user with matching GET rule → 200', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-updt');
      expect(res.status).to.equal(200);
    });

    it('restricted user with non-matching method → 403', async () => {
      const res = await request(app)
        .post('/api/hello')
        .set('Authorization', 'Bearer tok-updt');
      // POST is not in the rule for updt user; Express may return 404 for
      // unregistered POST route, but our authz middleware runs first
      // and should deny it with 403 before the route handler.
      expect(res.status).to.equal(403);
    });
  });

  describe('Unknown user (authenticated but not in authz config)', () => {
    let app: Express;

    before(async () => {
      process.env.DM_AUTH_TOKENS = 'tok-known:known,tok-unknown:unknown';
      process.env.DM_AUTHZ_PER_ROUTE = 'known:*';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTE;
    });

    it('known user → 200', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-known');
      expect(res.status).to.equal(200);
    });

    it('authenticated but unknown-to-authz user → 403', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-unknown');
      expect(res.status).to.equal(403);
    });
  });

  describe('No auth plugin (req.user unset)', () => {
    let app: Express;

    before(async () => {
      delete process.env.DM_AUTH_TOKENS;
      process.env.DM_AUTHZ_PER_ROUTE = 'someuser:*';
      const dm = new DM();
      await dm.ready;
      // Only authz + helloWorld, no auth plugin → req.user stays unset
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTHZ_PER_ROUTE;
    });

    it('unauthenticated request passes through authz middleware → 200', async () => {
      const res = await request(app).get('/api/hello');
      expect(res.status).to.equal(200);
    });
  });

  describe('Invalid rule entries are ignored (no crash)', () => {
    let app: Express;

    before(async () => {
      process.env.DM_AUTH_TOKENS = 'tok-full:full';
      // "badentry" has no colon → invalid and should be skipped
      process.env.DM_AUTHZ_PER_ROUTE = 'badentry,full:*';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTE;
    });

    it('still starts and valid rules work', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-full');
      expect(res.status).to.equal(200);
    });
  });

  describe('Method wildcard rule (*)', () => {
    let app: Express;

    before(async () => {
      process.env.DM_AUTH_TOKENS = 'tok-any:any';
      // any method on /api/hello
      process.env.DM_AUTHZ_PER_ROUTE = 'any:*:/api/hello';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTE;
    });

    it('method wildcard * allows GET', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-any');
      expect(res.status).to.equal(200);
    });
  });
});
