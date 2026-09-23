/**
 * OpenID Connect goes through the authentication dispatcher
 * (GHSA-5hf3-x776-76wh).
 *
 * The plugin used to mount three layers of its own in `api()` — the
 * `beforeAuth` hooks, the library's router, then `req.user` — which kept
 * their registration order. A named instance, the only form that can carry
 * `auth_path_prefix`, landed in the parallel batch and mounted *after* the
 * plugins meant to read what it publishes: `core/auth/authzPerRoute` judged
 * every rule before `req.user` existed, and it passes a request it cannot
 * identify. The rules read as enforced and were inert.
 *
 * It is an `AuthBase` now, so the dispatcher — mounted before any plugin can
 * register a route — runs it, and only it, for the paths it claims.
 */
import { expect } from 'chai';
import nock from 'nock';
import supertest from 'supertest';
import type { Express, Request, Response } from 'express';

import { DM } from '../../../src/bin';
import DmPlugin from '../../../src/abstract/plugin';
import OpenIDConnect from '../../../src/plugins/auth/openidconnect';
import AuthToken from '../../../src/plugins/auth/token';
import AuthzPerRoute from '../../../src/plugins/auth/authzPerRoute';

const OIDC_SERVER = 'http://oidc.example.test';

/** Three routes: under the OIDC branch, under the token's, under nobody's */
class Probe extends DmPlugin {
  name = 'probe';

  api(app: Express): void {
    const answer = (req: Request, res: Response): void => {
      res.json({
        served: true,
        // @ts-expect-error `user` is what an authenticator publishes
        user: (req.user as string) ?? null,
      });
    };
    app.get('/api/admin/probe', answer);
    app.get('/api/open/probe', answer);
    app.get('/api/nothing/probe', answer);
  }
}

describe('OpenID Connect through the dispatcher', function () {
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of ['DM_AUTH_TOKENS', 'DM_AUTHZ_PER_ROUTES'])
      saved[k] = process.env[k];
    nock(OIDC_SERVER)
      .persist()
      .get('/.well-known/openid-configuration')
      .reply(200, {
        issuer: OIDC_SERVER,
        authorization_endpoint: `${OIDC_SERVER}/authorize`,
        token_endpoint: `${OIDC_SERVER}/token`,
        userinfo_endpoint: `${OIDC_SERVER}/userinfo`,
        jwks_uri: `${OIDC_SERVER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
  });

  after(() => {
    nock.cleanAll();
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  /** A server whose OIDC instance guards `/api/admin` alone */
  const build = async (
    options: { token?: boolean; rule?: string; oidcFirst?: boolean } = {}
  ): Promise<{ server: DM; request: ReturnType<typeof supertest> }> => {
    if (options.rule) process.env.DM_AUTHZ_PER_ROUTES = options.rule;
    else delete process.env.DM_AUTHZ_PER_ROUTES;
    if (options.token) process.env.DM_AUTH_TOKENS = 'statictoken:machine';
    else delete process.env.DM_AUTH_TOKENS;

    const server = new DM();
    await server.ready;
    server.config.oidc_server = OIDC_SERVER;
    server.config.oidc_client_id = 'client';
    server.config.oidc_client_secret = 'a-secret-long-enough-for-the-library';
    server.config.base_url = 'http://localhost:3000';

    // Scoped the way the documentation recommends, which is the form that
    // used to lose its place in the middleware stack.
    const scoped = server.withConfig({
      ...server.config,
      auth_path_prefix: ['/api/admin'],
    });
    const oidc = new OpenIDConnect(scoped);
    if (options.oidcFirst) await server.registerPlugin('openidconnect', oidc);
    // The route plugin registers first, on purpose: that is the order the
    // advisory describes, and the dispatcher is what makes it not matter.
    await server.registerPlugin('probe', new Probe(server));
    if (options.rule)
      await server.registerPlugin('authzPerRoute', new AuthzPerRoute(server));
    if (options.token) {
      // Scoped too, so that a route outside both prefixes exists: a
      // catch-all authenticator guards everything and there would be
      // nothing to report.
      const scopedToken = server.withConfig({
        ...server.config,
        auth_path_prefix: ['/api/open'],
      });
      await server.registerPlugin('authToken', new AuthToken(scopedToken));
    }
    if (!options.oidcFirst) await server.registerPlugin('openidconnect', oidc);
    server.setupErrorMiddleware();
    return { server, request: supertest(server.app) };
  };

  it('should not let a route answer before the session is read', async () => {
    const { request } = await build();
    const res = await request.get('/api/admin/probe');
    expect(res.body.served, JSON.stringify(res.body)).to.not.equal(true);
    // No session: the library redirects a browser to the provider.
    expect([302, 401]).to.include(res.status);
  });

  for (const oidcFirst of [false, true]) {
    const order = oidcFirst ? 'registered first' : 'registered last';

    it(`should leave the paths it does not claim alone (${order})`, async () => {
      // `auth_path_prefix` was accepted and ignored: the plugin guarded the
      // whole server whatever it was scoped to — and only the routes that
      // happened to register before it escaped, which is the other half of
      // the same accident.
      const { request } = await build({ oidcFirst });
      const res = await request.get('/api/open/probe');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.served).to.equal(true);
    });

    it(`should not ask a token holder for a second credential (${order})`, async () => {
      // Two authentications covering one request used to compose as an AND:
      // a valid bearer was answered with a 302 to the provider, since the
      // OIDC router ran anyway. Only the winning plugin runs now.
      const { request } = await build({ token: true, oidcFirst });
      const res = await request
        .get('/api/open/probe')
        .set('Authorization', 'Bearer statictoken');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.user).to.equal('machine');
    });
  }

  it('should still name the routes nothing guards', async () => {
    // `warnUnauthenticatedRoutes` gives up as soon as one authenticator
    // claims everything, and this plugin claimed nothing while guarding
    // everything — so loading it silenced the startup report.
    const { server } = await build({ token: true });
    const unguarded = server.warnUnauthenticatedRoutes();
    expect(unguarded, JSON.stringify(unguarded)).to.include(
      '/api/nothing/probe'
    );
    expect(unguarded).to.not.include('/api/admin/probe');
    expect(unguarded).to.not.include('/api/open/probe');
  });

  it('should claim its own routes, so nothing else answers the callback', async () => {
    const { server } = await build();
    const oidc = server.loadedPlugins['openidconnect'] as OpenIDConnect;
    expect(oidc.pathPrefixes).to.include('/api/admin');
    expect(oidc.pathPrefixes).to.include('/callback');
    expect(oidc.pathPrefixes).to.include('/backchannel-logout');
  });
});
