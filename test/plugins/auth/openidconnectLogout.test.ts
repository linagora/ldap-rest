/**
 * `/logout` ends the session at the provider too (RP-Initiated Logout).
 *
 * It used to drop the cookie alone. Every other path requires a session, so
 * the next request went through the provider, which still had its own, and
 * came back logged in without asking anything: the logout did nothing a
 * caller could see.
 */
import { createRequire } from 'module';
import { expect } from 'chai';
import nock from 'nock';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import OpenIDConnect from '../../../src/plugins/auth/openidconnect';
import ConfigApi from '../../../src/plugins/configApi';

// `express-openid-connect` encrypts its session cookie with keys it derives
// from the secret; the same helpers forge one here, which is what a browser
// holding a session sends.
const require = createRequire(__filename);
const { getKeyStore } = require('express-openid-connect/lib/crypto') as {
  getKeyStore: (secret: string, forEncryption: boolean) => [unknown];
};
const { JWE, JWK, JWT } = require('jose') as {
  JWE: {
    encrypt: (payload: string, key: unknown, header: object) => string;
  };
  JWK: { generateSync: (kty: string) => unknown };
  JWT: { sign: (claims: object, key: unknown) => string };
};

const SECRET = 'a-secret-long-enough-for-the-library';
const BASE_URL = 'http://localhost:3000';

/** The discovery document, with or without RP-Initiated Logout */
const discovery = (issuer: string, endSession: boolean): object => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  userinfo_endpoint: `${issuer}/userinfo`,
  jwks_uri: `${issuer}/jwks`,
  ...(endSession ? { end_session_endpoint: `${issuer}/logout` } : {}),
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
});

/** The cookie of a session established with `issuer`, and its id token */
const session = (issuer: string): { cookie: string; idToken: string } => {
  const idToken = JWT.sign(
    { iss: issuer, aud: 'client', sub: 'alice', sid: 'sid-1' },
    JWK.generateSync('oct')
  );
  const now = Math.floor(Date.now() / 1000);
  const value = JWE.encrypt(
    JSON.stringify({ id_token: idToken }),
    getKeyStore(SECRET, true)[0],
    { alg: 'dir', enc: 'A256GCM', iat: now, uat: now, exp: now + 3600 }
  );
  return { cookie: `appSession=${value}`, idToken };
};

const build = async (
  issuer: string,
  endSession: boolean
): Promise<ReturnType<typeof supertest>> => {
  nock(issuer)
    .persist()
    .get('/.well-known/openid-configuration')
    .reply(200, discovery(issuer, endSession));
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
    const { cookie, idToken } = session(issuer);

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
    const { cookie } = session(issuer);

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
