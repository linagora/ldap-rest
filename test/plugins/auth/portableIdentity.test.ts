/**
 * One caller, two names (#187).
 *
 * Authorization rules are keyed on `req.user`, and every authenticator fills
 * it with something else: a token's name, an OIDC `sub`, a tenant. A rule
 * written for one is inert under another — it refuses nobody, it matches
 * nobody — and with `authzLinid1` it was worse than inert until #191.
 *
 * So each authenticator now publishes the caller twice: `req.user`, this
 * server's identifier, and `req.userName`, the caller under a name a person
 * would use. `--authz-identity` says which one the authorization plugins
 * read, and its default changes nothing.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Express, Request, Response } from 'express';

import { DM } from '../../../src/bin';
import DmPlugin, { type Role } from '../../../src/abstract/plugin';
import AuthToken from '../../../src/plugins/auth/token';
import AuthTotp from '../../../src/plugins/auth/totp';
import AuthHmac from '../../../src/plugins/auth/hmac';
import OpenIDConnect from '../../../src/plugins/auth/openidconnect';
import AuthzPerRoute from '../../../src/plugins/auth/authzPerRoute';
import type { DmRequest } from '../../../src/lib/auth/base';
import { BaseResolver } from '../../../src/plugins/scim/baseResolver';

/** Reports what the authenticators left on the request */
class Probe extends DmPlugin {
  name = 'probe';

  api(app: Express): void {
    app.get('/api/who', (req: Request, res: Response) => {
      const dm = req as DmRequest;
      res.json({ user: dm.user ?? null, userName: dm.userName ?? null });
    });
  }
}

describe('The two names of a caller', function () {
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of [
      'DM_AUTH_TOKENS',
      'DM_AUTH_TOTP',
      'DM_AUTH_HMAC',
      'DM_AUTHZ_PER_ROUTES',
      'DM_AUTHZ_IDENTITY',
      'DM_OIDC_SERVER',
      'DM_OIDC_CLIENT_ID',
      'DM_OIDC_CLIENT_SECRET',
      'DM_OIDC_USERNAME_CLAIM',
      'DM_BASE_URL',
    ])
      saved[k] = process.env[k];
  });

  after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  describe('what each authenticator publishes', () => {
    it('should publish the token name under both names', async () => {
      process.env.DM_AUTH_TOKENS = 'tok:machine';
      const server = new DM();
      await server.ready;
      await server.registerPlugin('probe', new Probe(server));
      await server.registerPlugin('authToken', new AuthToken(server));
      server.setupErrorMiddleware();
      const res = await supertest(server.app)
        .get('/api/who')
        .set('Authorization', 'Bearer tok');
      expect(res.body).to.deep.equal({
        user: 'machine',
        userName: 'machine',
      });
      delete process.env.DM_AUTH_TOKENS;
    });

    it('should list the identities each of them can publish', async () => {
      // What the startup check reads, so that a rule keyed on a name nobody
      // can publish is named at startup rather than found months later.
      process.env.DM_AUTH_TOKENS = 'tok:machine';
      process.env.DM_AUTH_TOTP = 'JBSWY3DPEHPK3PXP:operator';
      process.env.DM_AUTH_HMAC = 'svc:secret-value:billing';
      const server = new DM();
      await server.ready;
      type Listing = { knownIdentities(): string[] | undefined };
      const listed = (plugin: unknown): string[] | undefined =>
        (plugin as Listing).knownIdentities();
      expect(listed(new AuthToken(server))).to.deep.equal(['machine']);
      expect(listed(new AuthTotp(server))).to.deep.equal(['operator']);
      expect(listed(new AuthHmac(server))).to.deep.equal(['billing']);
      for (const k of ['DM_AUTH_TOKENS', 'DM_AUTH_TOTP', 'DM_AUTH_HMAC'])
        delete process.env[k];
    });

    it('should publish the OIDC sub and the configured claim apart', async () => {
      process.env.DM_OIDC_SERVER = 'http://oidc.example.test';
      process.env.DM_OIDC_CLIENT_ID = 'client';
      process.env.DM_OIDC_CLIENT_SECRET = 'a-secret-long-enough-for-the-lib';
      process.env.DM_BASE_URL = 'http://localhost:3000';
      process.env.DM_OIDC_USERNAME_CLAIM = 'preferred_username';
      const server = new DM();
      await server.ready;
      const plugin = new OpenIDConnect(server);
      // The library's router is what reads the session; here it is the
      // session, so the claim handling is what the test is about.
      (
        plugin as unknown as {
          router: (req: unknown, res: unknown, next: () => void) => void;
        }
      ).router = (req, _res, next) => {
        (req as { oidc: unknown }).oidc = {
          isAuthenticated: () => true,
          user: { sub: 'auth0|17', preferred_username: 'dwho' },
        };
        next();
      };

      const req = { headers: {} } as unknown as DmRequest;
      let passed = false;
      plugin.authMethod(req, {} as Response, () => {
        passed = true;
      });
      expect(passed).to.equal(true);
      expect(req.user, 'the key rules are written on today').to.equal(
        'auth0|17'
      );
      expect(req.userName, 'the login a person would write').to.equal('dwho');
      delete process.env.DM_OIDC_USERNAME_CLAIM;
    });
  });

  describe('what the authorization plugins key on', () => {
    /** A server whose caller is `auth0|17`, known to people as `dwho` */
    const build = async (
      identity: string,
      rule: string
    ): Promise<ReturnType<typeof supertest>> => {
      process.env.DM_AUTHZ_IDENTITY = identity;
      process.env.DM_AUTHZ_PER_ROUTES = rule;
      const server = new DM();
      await server.ready;

      class TwoNamed extends DmPlugin {
        name = 'twoNamed';
        roles: Role[] = ['auth'] as const;

        api(app: Express): void {
          app.use((req, _res, next) => {
            const dm = req as DmRequest;
            dm.user = 'auth0|17';
            dm.userName = 'dwho';
            next();
          });
        }
      }

      await server.registerPlugin('twoNamed', new TwoNamed(server));
      await server.registerPlugin('authzPerRoute', new AuthzPerRoute(server));
      await server.registerPlugin('probe', new Probe(server));
      server.setupErrorMiddleware();
      return supertest(server.app);
    };

    after(() => {
      delete process.env.DM_AUTHZ_IDENTITY;
      delete process.env.DM_AUTHZ_PER_ROUTES;
    });

    it('should match a rule written on the login when asked to', async () => {
      const request = await build('req.userName', 'dwho:GET:/api/who');
      const res = await request.get('/api/who');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('should not match that rule under the default', async () => {
      // The default keeps every existing rule meaning what it meant: the
      // login names nobody the server knows, so the rule is inert — and a
      // rule that matches nothing refuses, which is the safe half.
      const request = await build('req.user', 'dwho:GET:/api/who');
      const res = await request.get('/api/who');
      expect(res.status).to.equal(403);
    });

    it('should match the identifier under the default', async () => {
      const request = await build('req.user', 'auth0|17:GET:/api/who');
      const res = await request.get('/api/who');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('should refuse it in the SCIM base resolver too', async () => {
      // A deployment running SCIM without an authorization plugin gets no
      // other validator, and the base a request is served from is keyed on
      // the same value a rule is.
      process.env.DM_AUTHZ_IDENTITY = 'req.userNames';
      const server = new DM();
      await server.ready;
      expect(() => new BaseResolver(server.config)).to.throw(
        /unknown --authz-identity "req.userNames"/
      );
      delete process.env.DM_AUTHZ_IDENTITY;
    });

    it('should refuse an --authz-identity nobody wrote', async () => {
      process.env.DM_AUTHZ_IDENTITY = 'req.userNames';
      const server = new DM();
      await server.ready;
      expect(() => new AuthzPerRoute(server)).to.throw(
        /unknown --authz-identity "req.userNames"\. Known: req\.user, req\.userName/
      );
      delete process.env.DM_AUTHZ_IDENTITY;
    });
  });
});
