/**
 * The plugins whose credential is a cookie refuse a change a browser sends
 * from another site: the cookie goes with it whichever page asks, and a form
 * posted from a sibling subdomain is a request without a preflight.
 */
import { expect } from 'chai';
import type { Express, Request, Response } from 'express';
import nock from 'nock';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import type { Role } from '../../../src/abstract/plugin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import AuthLLNG from '../../../src/plugins/auth/llng';
import OpenIDConnect from '../../../src/plugins/auth/openidconnect';
import Token from '../../../src/plugins/auth/token';
import {
  BASE_URL,
  SECRET,
  SESSION_SECRET,
  login,
  provider,
} from '../../helpers/oidcProvider';

const PASSWORD = '/api/admin/v1/ldap/users/bob/password';
const MACHINE = '/api/m/v1/ldap/users/bob/password';
const EVIL = 'https://evil.example.test';
const CONSOLE = 'https://console.example.test';

/** What the route saw, when the request reached it */
const echo = (req: Request, res: Response): void => {
  res.json({ user: (req as { user?: string }).user, body: req.body as object });
};

/**
 * OpenID Connect on `/api/admin`, a token on `/api/m`, and the same route
 * under both.
 */
const build = async (
  issuer: string,
  config: Record<string, unknown> = {}
): Promise<ReturnType<typeof supertest>> => {
  provider(issuer, true);
  const server = new DM();
  await server.ready;
  Object.assign(server.config, {
    oidc_server: issuer,
    oidc_client_id: 'client',
    oidc_client_secret: SECRET,
    oidc_session_secret: [SESSION_SECRET],
    base_url: BASE_URL,
    ...config,
  });
  await server.registerPlugin(
    'openidconnect',
    new OpenIDConnect(
      server.withConfig({ ...server.config, auth_path_prefix: ['/api/admin'] })
    )
  );
  await server.registerPlugin(
    'token',
    new Token(
      server.withConfig({
        ...server.config,
        auth_path_prefix: ['/api/m'],
        auth_token: ['machine-token:robot'],
      })
    )
  );
  server.app.post(PASSWORD, echo);
  server.app.put(PASSWORD, echo);
  server.app.delete(PASSWORD, echo);
  server.app.post('/api/admin/callback', echo);
  server.app.post(MACHINE, echo);
  server.app.get('/api/admin/v1/ldap/users/bob', echo);
  server.setupErrorMiddleware();
  return supertest(server.app);
};

/** The configuration OpenID Connect needs to start, against no provider */
const startable = (
  config: Record<string, unknown>
): Record<string, unknown> => ({
  oidc_server: 'http://csw-startup.example.test',
  oidc_client_id: 'client',
  oidc_client_secret: SECRET,
  oidc_session_secret: [SESSION_SECRET],
  base_url: BASE_URL,
  ...config,
});

/** A password change as a form posts it */
const changePassword = (
  request: ReturnType<typeof supertest>,
  cookie: string,
  headers: Record<string, string>
): supertest.Test =>
  request
    .post(PASSWORD)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .set(headers)
    .send('password=chosen-by-someone-else');

describe('OpenID Connect, changes from another site', function () {
  afterEach(() => nock.cleanAll());

  let n = 0;
  const issuer = (): string => `http://csw-${++n}.example.test`;

  for (const [name, headers] of [
    ['a same-site page', { 'Sec-Fetch-Site': 'same-site' }],
    ['a cross-site page', { 'Sec-Fetch-Site': 'cross-site' }],
    ['an Origin of another site', { Origin: EVIL }],
    ['an Origin of a sibling subdomain', { Origin: 'http://evil.localhost' }],
    ['an opaque Origin', { Origin: 'null' }],
    ['a Referer of another site', { Referer: `${EVIL}/form` }],
    [
      'another Origin with a trusted Referer',
      { Origin: EVIL, Referer: `${BASE_URL}/users` },
    ],
    [
      'a trusted Origin with another Referer',
      { Origin: BASE_URL, Referer: `${EVIL}/form` },
    ],
  ] as [string, Record<string, string>][])
    it(`refuses a form posted from ${name}`, async () => {
      const iss = issuer();
      const request = await build(iss);
      const { cookie } = await login(request, iss);

      const res = await changePassword(request, cookie, headers);

      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(res.body.user, 'the route is not reached').to.equal(undefined);
    });

  for (const [name, headers] of [
    ['the --base-url origin', { Origin: BASE_URL }],
    ['the same origin', { 'Sec-Fetch-Site': 'same-origin' }],
    ['a client sending no browser header', {}],
  ] as [string, Record<string, string>][])
    it(`serves a change from ${name}`, async () => {
      const iss = issuer();
      const request = await build(iss);
      const { cookie } = await login(request, iss);

      const res = await changePassword(request, cookie, headers);

      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body).to.deep.equal({
        user: 'alice',
        body: { password: 'chosen-by-someone-else' },
      });
    });

  for (const method of ['put', 'delete'] as const)
    it(`refuses a ${method.toUpperCase()} from another site`, async () => {
      const iss = issuer();
      const request = await build(iss);
      const { cookie } = await login(request, iss);

      const res = await request[method](PASSWORD)
        .set('Cookie', cookie)
        .set('Accept', 'application/json')
        .set('Sec-Fetch-Site', 'cross-site')
        .set('Origin', EVIL);

      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(res.body.user, 'the route is not reached').to.equal(undefined);
    });

  for (const option of ['auth_trusted_origin', 'oidc_logout_origins'])
    it(`serves a change from a console listed in ${option}`, async () => {
      const iss = issuer();
      const request = await build(iss, { [option]: [CONSOLE] });
      const { cookie } = await login(request, iss);

      const res = await changePassword(request, cookie, {
        'Sec-Fetch-Site': 'same-site',
        Origin: CONSOLE,
      });

      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.user).to.equal('alice');
    });

  it('leaves a read from another site alone', async () => {
    const iss = issuer();
    const request = await build(iss);
    const { cookie } = await login(request, iss);

    const res = await request
      .get('/api/admin/v1/ldap/users/bob')
      .set('Cookie', cookie)
      .set('Accept', 'application/json')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', EVIL);

    expect(res.status).to.equal(200);
    expect(res.body.user).to.equal('alice');
  });

  it('leaves a request another plugin authenticates alone', async () => {
    const request = await build(issuer());

    const res = await request
      .post(MACHINE)
      .set('Authorization', 'Bearer machine-token')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', EVIL)
      .type('form')
      .send('password=x');

    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.user).to.equal('robot');
  });

  it('leaves the provider post to /callback to the library', async () => {
    const request = await build(issuer());

    const res = await request
      .post('/callback')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://provider.example.test')
      .type('form')
      .send('code=c&state=s');

    expect(res.status).to.not.equal(403);
  });

  it('leaves the provider post to /backchannel-logout to the library', async () => {
    const request = await build(issuer());

    const res = await request
      .post('/backchannel-logout')
      .set('Origin', 'https://provider.example.test')
      .type('form')
      .send('logout_token=not-a-token');

    expect(res.status, JSON.stringify(res.body)).to.not.equal(403);
  });

  it('refuses a form posted from another site to another /callback', async () => {
    const iss = issuer();
    const request = await build(iss);
    const { cookie } = await login(request, iss);

    const res = await request
      .post('/api/admin/callback')
      .set('Cookie', cookie)
      .set('Accept', 'application/json')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', EVIL)
      .type('form')
      .send('code=c&state=s');

    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('refuses a trusted origin that is not a URL at startup', async () => {
    const server = new DM();
    await server.ready;
    Object.assign(
      server.config,
      startable({ auth_trusted_origin: 'console.example.test' })
    );

    expect(() => new OpenIDConnect(server)).to.throw(
      /--auth-trusted-origin holds "console.example.test"/
    );
  });

  for (const value of [
    `${CONSOLE}/app`,
    `${CONSOLE}/?tab=users`,
    `${CONSOLE}/#users`,
    'https://admin@console.example.test',
  ])
    it(`refuses ${value} as a trusted origin at startup`, async () => {
      const server = new DM();
      await server.ready;
      Object.assign(server.config, startable({ auth_trusted_origin: [value] }));

      expect(() => new OpenIDConnect(server)).to.throw(
        /--auth-trusted-origin holds .*, which is not an origin/
      );
    });

  it('accepts an origin written with a trailing slash or a default port', async () => {
    const server = new DM();
    await server.ready;
    Object.assign(
      server.config,
      startable({
        auth_trusted_origin: [`${CONSOLE}/`, 'https://other.example.test:443'],
      })
    );

    expect(() => new OpenIDConnect(server)).to.not.throw();
  });

  it('still accepts a URL with a path in --oidc-logout-origins', async () => {
    const server = new DM();
    await server.ready;
    Object.assign(
      server.config,
      startable({ oidc_logout_origins: [`${CONSOLE}/app`] })
    );

    expect(() => new OpenIDConnect(server)).to.not.throw();
  });

  it('refuses a --base-url that is not a URL at startup', async () => {
    const server = new DM();
    await server.ready;
    Object.assign(
      server.config,
      startable({ base_url: 'ldap-rest.example.test' })
    );

    expect(() => new OpenIDConnect(server)).to.throw(
      /--base-url holds "ldap-rest.example.test", which is not a URL/
    );
  });
});

describe('LemonLDAP::NG, changes from another site', () => {
  /** A handler that vouches for everyone, and counts what it saw */
  const handler = (): {
    seen: { runs: number };
    init: () => Promise<unknown>;
    run: (
      req: { headers: Record<string, string> },
      res: unknown,
      next: () => void
    ) => void;
  } => {
    const seen = { runs: 0 };
    return {
      seen,
      init: async (): Promise<unknown> => ({ tsv: { locationRegexp: {} } }),
      run: (
        req: { headers: Record<string, string> },
        _res: unknown,
        next: () => void
      ): void => {
        seen.runs++;
        req.headers['Lm-Remote-User'] = 'dwho';
        next();
      },
    };
  };

  const build = async (
    config: Record<string, unknown> = {}
  ): Promise<{
    request: ReturnType<typeof supertest>;
    seen: { runs: number };
  }> => {
    const fake = handler();
    const server = new DM();
    await server.ready;
    Object.assign(server.config, config);
    const plugin = new (class extends AuthLLNG {
      protected async loadHandler(): Promise<never> {
        return fake as never;
      }
    })(server);
    await plugin.api(server.app as Express);
    server.app.post(PASSWORD, echo);
    server.app.get(PASSWORD, echo);
    server.setupErrorMiddleware();
    return { request: supertest(server.app), seen: fake.seen };
  };

  const post = (
    request: ReturnType<typeof supertest>,
    headers: Record<string, string>
  ): supertest.Test =>
    request
      .post(PASSWORD)
      .set('Accept', 'application/json')
      .type('form')
      .set(headers)
      .send('password=x');

  for (const [name, headers] of [
    ['a same-site page', { 'Sec-Fetch-Site': 'same-site' }],
    ['an Origin of another site', { Origin: EVIL }],
    [
      'a trusted Origin with another Referer',
      { Origin: BASE_URL, Referer: `${EVIL}/form` },
    ],
  ] as [string, Record<string, string>][])
    it(`refuses a form posted from ${name}, before the handler`, async () => {
      const { request, seen } = await build({ base_url: BASE_URL });

      const res = await post(request, headers);

      expect(res.status).to.equal(403);
      expect(seen.runs).to.equal(0);
    });

  for (const [name, config, headers] of [
    ['the --base-url origin', { base_url: BASE_URL }, { Origin: BASE_URL }],
    [
      'a console listed in --auth-trusted-origin',
      { auth_trusted_origin: [CONSOLE] },
      { 'Sec-Fetch-Site': 'same-site', Origin: CONSOLE },
    ],
    ['the same origin', {}, { 'Sec-Fetch-Site': 'same-origin' }],
    ['a client sending no browser header', {}, {}],
  ] as [string, Record<string, unknown>, Record<string, string>][])
    it(`serves a change from ${name}`, async () => {
      const { request } = await build(config);

      const res = await post(request, headers);

      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body).to.deep.equal({
        user: 'dwho',
        body: { password: 'x' },
      });
    });

  it('leaves a read from another site alone', async () => {
    const { request } = await build();

    const res = await request
      .get(PASSWORD)
      .set('Accept', 'application/json')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', EVIL);

    expect(res.status).to.equal(200);
    expect(res.body.user).to.equal('dwho');
  });

  it('refuses a trusted origin that is not a URL at startup', async () => {
    const server = new DM();
    await server.ready;
    server.config.auth_trusted_origin = ['console.example.test'];

    expect(() => new AuthLLNG(server)).to.throw(
      /--auth-trusted-origin holds "console.example.test"/
    );
  });

  it('refuses a trusted origin with a path at startup', async () => {
    const server = new DM();
    await server.ready;
    server.config.auth_trusted_origin = [`${CONSOLE}/app`];

    expect(() => new AuthLLNG(server)).to.throw(
      /--auth-trusted-origin holds .*, which is not an origin/
    );
  });

  it('refuses a --base-url that is not a URL at startup', async () => {
    const server = new DM();
    await server.ready;
    server.config.base_url = 'ldap-rest.example.test';

    expect(() => new AuthLLNG(server)).to.throw(
      /--base-url holds "ldap-rest.example.test", which is not a URL/
    );
  });
});

describe('AuthBase, a plugin naming its trusted origins', () => {
  /** A cookie plugin of a third party, which vouches for everyone */
  class Cookie extends AuthBase {
    name = 'cookie';
    roles: Role[] = ['auth'];
    runs = 0;

    protected trustedOrigins(): readonly string[] {
      return [CONSOLE];
    }

    protected crossSiteExempt(req: DmRequest): boolean {
      return req.path === '/hook';
    }

    authMethod(req: DmRequest, _res: Response, next: () => void): void {
      this.runs++;
      this.publishIdentity(req, 'carol');
      next();
    }
  }

  const build = async (): Promise<{
    request: ReturnType<typeof supertest>;
    plugin: Cookie;
  }> => {
    const server = new DM();
    await server.ready;
    const plugin = new Cookie(server);
    await server.registerPlugin('cookie', plugin);
    server.app.post(PASSWORD, echo);
    server.app.post('/hook', echo);
    server.setupErrorMiddleware();
    return { request: supertest(server.app), plugin };
  };

  it('refuses a change from another site before authMethod', async () => {
    const { request, plugin } = await build();

    const res = await request
      .post(PASSWORD)
      .set('Accept', 'application/json')
      .set('Origin', EVIL)
      .send({ password: 'x' });

    expect(res.status).to.equal(403);
    expect(plugin.runs).to.equal(0);
  });

  it('serves a change from an origin it trusts', async () => {
    const { request } = await build();

    const res = await request
      .post(PASSWORD)
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', CONSOLE)
      .send({ password: 'x' });

    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.user).to.equal('carol');
  });

  it('leaves a route it exempts to authMethod', async () => {
    const { request, plugin } = await build();

    const res = await request
      .post('/hook')
      .set('Origin', EVIL)
      .send({ event: 'x' });

    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(plugin.runs).to.equal(1);
  });
});
