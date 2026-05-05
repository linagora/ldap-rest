import { DM } from '../../../src/bin';
import type { Express } from 'express';
import request from 'supertest';
import AuthToken from '../../../src/plugins/auth/token';
import AuthzPerRoute, {
  globToRegex,
} from '../../../src/plugins/auth/authzPerRoute';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import { expect } from 'chai';

describe('AuthzPerRoute', () => {
  describe('Basic rule enforcement', () => {
    let app: Express;

    before(async () => {
      // full:tok-full → wildcard; updt:tok-updt → GET /api/hello only
      process.env.DM_AUTH_TOKENS = 'tok-full:full,tok-updt:updt';
      process.env.DM_AUTHZ_PER_ROUTES = 'full:*,updt:GET:/api/hello';
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
      delete process.env.DM_AUTHZ_PER_ROUTES;
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
      process.env.DM_AUTHZ_PER_ROUTES = 'known:*';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
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
      process.env.DM_AUTHZ_PER_ROUTES = 'someuser:*';
      const dm = new DM();
      await dm.ready;
      // Only authz + helloWorld, no auth plugin → req.user stays unset
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTHZ_PER_ROUTES;
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
      process.env.DM_AUTHZ_PER_ROUTES = 'badentry,full:*';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
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
      // any method on /api/hello (exact glob — no wildcards in path)
      process.env.DM_AUTHZ_PER_ROUTES = 'any:*:/api/hello';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('method wildcard * allows GET', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-any');
      expect(res.status).to.equal(200);
    });
  });

  describe('globToRegex — glob semantics', () => {
    describe('* (single segment wildcard)', () => {
      it('matches one path segment', () => {
        const re = globToRegex('/api/*');
        expect(re.test('/api/hello')).to.equal(true);
      });

      it('does NOT cross a slash (no multi-segment match)', () => {
        const re = globToRegex('/api/*');
        expect(re.test('/api/hello/world')).to.equal(false);
      });

      it('does NOT match the prefix without a segment', () => {
        const re = globToRegex('/api/*');
        expect(re.test('/api')).to.equal(false);
      });
    });

    describe('** (multi-segment wildcard)', () => {
      it('matches a single segment', () => {
        const re = globToRegex('/api/**');
        expect(re.test('/api/hello')).to.equal(true);
      });

      it('crosses slashes (matches multiple segments)', () => {
        const re = globToRegex('/api/**');
        expect(re.test('/api/hello/world')).to.equal(true);
      });

      it('does NOT match the prefix alone (** must consume at least something)', () => {
        const re = globToRegex('/api/**');
        expect(re.test('/api')).to.equal(false);
      });
    });

    describe('** appended directly to a prefix', () => {
      it('matches the exact prefix', () => {
        const re = globToRegex('/api/hello**');
        expect(re.test('/api/hello')).to.equal(true);
      });

      it('matches the prefix with sub-paths', () => {
        const re = globToRegex('/api/hello**');
        expect(re.test('/api/hello/sub')).to.equal(true);
        expect(re.test('/api/hello/sub/deep')).to.equal(true);
      });

      it('does NOT match a shorter string', () => {
        const re = globToRegex('/api/hello**');
        expect(re.test('/api/hell')).to.equal(false);
      });
    });

    describe('regex metacharacters in glob are treated literally', () => {
      it('. matches only a literal dot, not any character', () => {
        const re = globToRegex('/api/hello.bak');
        expect(re.test('/api/hello.bak')).to.equal(true);
        expect(re.test('/api/helloXbak')).to.equal(false);
      });

      it('+ in pattern is literal', () => {
        const re = globToRegex('/path+extra');
        expect(re.test('/path+extra')).to.equal(true);
        expect(re.test('/pathextra')).to.equal(false);
      });
    });

    describe('whitelist validation', () => {
      it('throws on semicolon in glob', () => {
        expect(() => globToRegex('foo;bar')).to.throw(/Invalid glob pattern/);
      });

      it('throws on space in glob', () => {
        expect(() => globToRegex('foo bar')).to.throw(/Invalid glob pattern/);
      });
    });
  });

  describe('Malformed glob in rule is ignored (no crash)', () => {
    let app: Express;

    before(async () => {
      process.env.DM_AUTH_TOKENS = 'tok-valid:validuser';
      // "foo?bar" contains a question-mark — invalid glob, rule must be skipped.
      // Deliberately avoid ';' here because the config parser uses ';' as array
      // separator when present in the env-var value, which would mangle the entry.
      process.env.DM_AUTHZ_PER_ROUTES =
        'validuser:GET:foo?bar,validuser:GET:/api/hello';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      app = dm.app;
    });

    after(() => {
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('plugin starts and valid rule still works', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-valid');
      expect(res.status).to.equal(200);
    });

    it('malformed-glob rule does not grant access (returns 403 on unmatched path)', async () => {
      const res = await request(app)
        .get('/some/other/path')
        .set('Authorization', 'Bearer tok-valid');
      expect(res.status).to.equal(403);
    });
  });

  describe('parseEntry — trim and validation', () => {
    // These tests inject entries directly into dm.config to bypass the env-var
    // parser (which splits on whitespace). This simulates CLI usage where the
    // shell preserves spaces inside quoted arguments, e.g.:
    //   --authz-per-route " user :*"

    it('entry with leading/trailing whitespace around user parses correctly (wildcard)', async () => {
      process.env.DM_AUTH_TOKENS = 'tok-ws:user';
      process.env.DM_AUTHZ_PER_ROUTES = 'placeholder';
      const dm = new DM();
      await dm.ready;
      // Inject the whitespace-containing entry directly, bypassing env-var splitting
      (dm.config as Record<string, unknown>).authz_per_route = [' user :*'];
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      const res = await request(dm.app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-ws');
      expect(res.status).to.equal(200);
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('entry with space before path trims correctly → 200', async () => {
      process.env.DM_AUTH_TOKENS = 'tok-sp:user';
      process.env.DM_AUTHZ_PER_ROUTES = 'placeholder';
      const dm = new DM();
      await dm.ready;
      // Inject the entry with a space before the path
      (dm.config as Record<string, unknown>).authz_per_route = [
        'user:GET: /api/hello',
      ];
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      const res = await request(dm.app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-sp');
      expect(res.status).to.equal(200);
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('entry with unknown method is ignored → user has no rules → 403', async () => {
      process.env.DM_AUTH_TOKENS = 'tok-bogus:user';
      process.env.DM_AUTHZ_PER_ROUTES = 'user:BOGUS:/api/hello';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      const res = await request(dm.app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-bogus');
      expect(res.status).to.equal(403);
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('entry with empty method after trim is ignored → 403', async () => {
      process.env.DM_AUTH_TOKENS = 'tok-em:user';
      process.env.DM_AUTHZ_PER_ROUTES = 'user::/api/hello';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      const res = await request(dm.app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-em');
      expect(res.status).to.equal(403);
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('entry with empty user is ignored; other rules still apply', async () => {
      process.env.DM_AUTH_TOKENS = 'tok-eu:realuser';
      process.env.DM_AUTHZ_PER_ROUTES = ':GET:/api/hello,realuser:*';
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authToken', new AuthToken(dm));
      await dm.registerPlugin('authzPerRoute', new AuthzPerRoute(dm));
      await dm.registerPlugin('helloWorld', new HelloWorld(dm));
      const res = await request(dm.app)
        .get('/api/hello')
        .set('Authorization', 'Bearer tok-eu');
      expect(res.status).to.equal(200);
      delete process.env.DM_AUTH_TOKENS;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });
  });
});
