/**
 * `/logout` ends the session at the provider too (RP-Initiated Logout).
 *
 * It used to drop the cookie alone. Every other path requires a session, so
 * the next request went through the provider, which still had its own, and
 * came back logged in without asking anything: the logout did nothing a
 * caller could see.
 */
import { generateKeyPairSync, sign } from 'crypto';
import { expect } from 'chai';
import nock from 'nock';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import OpenIDConnect from '../../../src/plugins/auth/openidconnect';
import ConfigApi from '../../../src/plugins/configApi';

const SECRET = 'a-secret-long-enough-for-the-library';
const BASE_URL = 'http://localhost:3000';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };

/** The provider's discovery and keys, with or without RP-Initiated Logout */
const provider = (issuer: string, endSession: boolean): void => {
  nock(issuer)
    .persist()
    .get('/.well-known/openid-configuration')
    .reply(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      ...(endSession ? { end_session_endpoint: `${issuer}/logout` } : {}),
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    })
    .get('/jwks')
    .reply(200, { keys: [JWK] });
};

const b64 = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Name=value of each cookie set by a response, ready for a Cookie header */
const cookies = (res: supertest.Response): string =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .map(c => c.split(';')[0])
    .join('; ');

/**
 * Log in as a browser does, through `/login` and `/callback`, so the session
 * cookie is the library's own.
 */
const login = async (
  request: ReturnType<typeof supertest>,
  issuer: string
): Promise<{ cookie: string; idToken: string }> => {
  const start = await request.get('/login');
  const authorize = new URL(start.headers.location);
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const payload = b64({
    iss: issuer,
    aud: 'client',
    sub: 'alice',
    sid: 'sid-1',
    nonce: authorize.searchParams.get('nonce'),
    iat: now,
    exp: now + 3600,
  });
  const signature = sign(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    privateKey
  ).toString('base64url');
  const idToken = `${header}.${payload}.${signature}`;
  nock(issuer).post('/token').reply(200, {
    access_token: 'at',
    token_type: 'Bearer',
    id_token: idToken,
  });
  const back = await request
    .get('/callback')
    .query({ code: 'code', state: authorize.searchParams.get('state') })
    .set('Cookie', cookies(start));
  expect(back.status, 'the login completes').to.equal(302);
  return { cookie: cookies(back), idToken };
};

const build = async (
  issuer: string,
  endSession: boolean
): Promise<ReturnType<typeof supertest>> => {
  provider(issuer, endSession);
  const server = new DM();
  await server.ready;
  server.config.oidc_server = issuer;
  server.config.oidc_client_id = 'client';
  server.config.oidc_client_secret = SECRET;
  server.config.base_url = BASE_URL;
  // Scoped, so that `/v1/config` stays readable without a session.
  const scoped = server.withConfig({
    ...server.config,
    auth_path_prefix: ['/api/admin'],
  });
  await server.registerPlugin('openidconnect', new OpenIDConnect(scoped));
  await server.registerPlugin('configApi', new ConfigApi(server));
  server.setupErrorMiddleware();
  return supertest(server.app);
};

/** Whether the response expires the session cookie */
const clearsSession = (setCookie: string | string[] | undefined): boolean =>
  ([] as string[])
    .concat(setCookie ?? [])
    .some(c => /^appSession=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));

describe('OpenID Connect, RP-Initiated Logout', function () {
  afterEach(() => nock.cleanAll());

  it('should send the browser to the provider with the id token', async () => {
    const issuer = 'http://rpil.example.test';
    const request = await build(issuer, true);
    const { cookie, idToken } = await login(request, issuer);

    const res = await request.get('/logout').set('Cookie', cookie);

    expect(res.status).to.equal(302);
    const target = new URL(res.headers.location);
    expect(`${target.origin}${target.pathname}`).to.equal(`${issuer}/logout`);
    expect(target.searchParams.get('id_token_hint')).to.equal(idToken);
    // Registering a return at the provider is not asked of anyone.
    expect(target.searchParams.has('post_logout_redirect_uri')).to.equal(false);
    expect(clearsSession(res.headers['set-cookie'])).to.equal(true);
  });

  it('should still reach the provider without a session', async () => {
    const issuer = 'http://rpil-anonymous.example.test';
    const request = await build(issuer, true);

    const res = await request.get('/logout');

    expect(res.status).to.equal(302);
    expect(res.headers.location).to.equal(`${issuer}/logout`);
  });

  it('should end the session here when the provider has no endpoint', async () => {
    const issuer = 'http://no-rpil.example.test';
    const request = await build(issuer, false);
    const { cookie } = await login(request, issuer);

    const res = await request.get('/logout').set('Cookie', cookie);

    expect(res.status).to.equal(302);
    expect(res.headers.location).to.equal(BASE_URL);
    expect(clearsSession(res.headers['set-cookie'])).to.equal(true);
  });

  it('should publish the logout route in /v1/config', async () => {
    const request = await build('http://config.example.test', true);

    const res = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(res.status).to.equal(200);
    expect(res.body.features.openidconnect).to.deep.equal({
      enabled: true,
      endpoints: { logout: '/logout' },
    });
  });
});
