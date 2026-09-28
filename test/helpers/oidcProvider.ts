/**
 * A provider nock answers for, and a login through it as a browser does, so
 * the session cookie is the library's own.
 */
import { generateKeyPairSync, sign } from 'crypto';
import { expect } from 'chai';
import nock from 'nock';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import OpenIDConnect from '../../src/plugins/auth/openidconnect';
import ConfigApi from '../../src/plugins/configApi';

export const SECRET = 'a-secret-long-enough-for-the-library';
export const BASE_URL = 'http://localhost:3000';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };

/** The provider's discovery and keys, with or without RP-Initiated Logout */
export const provider = (issuer: string, endSession: boolean): void => {
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
export const cookies = (res: supertest.Response): string =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .map(c => c.split(';')[0])
    .join('; ');

/**
 * Log in as a browser does, through `/login` and `/callback`, so the session
 * cookie is the library's own.
 */
export const login = async (
  request: ReturnType<typeof supertest>,
  issuer: string,
  tokens: Record<string, unknown> = {}
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
  nock(issuer)
    .post('/token')
    .reply(200, {
      access_token: 'at',
      token_type: 'Bearer',
      id_token: idToken,
      ...tokens,
    });
  const back = await request
    .get('/callback')
    .query({ code: 'code', state: authorize.searchParams.get('state') })
    .set('Cookie', cookies(start));
  expect(back.status, 'the login completes').to.equal(302);
  return { cookie: cookies(back), idToken };
};

export const build = async (
  issuer: string,
  endSession: boolean,
  name?: string,
  routes?: (server: DM) => void
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
  await server.registerPlugin('openidconnect', new OpenIDConnect(scoped), name);
  await server.registerPlugin('configApi', new ConfigApi(server));
  routes?.(server);
  server.setupErrorMiddleware();
  return supertest(server.app);
};
