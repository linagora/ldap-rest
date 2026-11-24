import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { expect } from 'chai';
import express from 'express';
import request from 'supertest';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';

import { DM } from '../../../src/bin';
import type { DmRequest } from '../../../src/lib/auth/base';
import AuthJwt from '../../../src/plugins/auth/jwt';

/** A provider: discovery, JWKS, and switches to break them */
class Provider {
  issuer = '';
  keys: JWK[] = [];
  jwksStatus = 200;
  discoveryIssuer?: string;
  discoveryRedirect?: string;
  jwksHits = 0;
  discoveryHits = 0;
  private server?: Server;

  async start(): Promise<void> {
    const app = express();
    app.get('/realm/.well-known/openid-configuration', (_req, res) => {
      this.discoveryHits++;
      if (this.discoveryRedirect)
        return void res.redirect(302, this.discoveryRedirect);
      res.json({
        issuer: this.discoveryIssuer ?? this.issuer,
        jwks_uri: `${this.issuer}/certs`,
      });
    });
    app.get('/realm/certs', (_req, res) => {
      this.jwksHits++;
      if (this.jwksStatus !== 200)
        return void res.status(this.jwksStatus).end();
      res.json({ keys: this.keys });
    });
    await new Promise<void>(resolve => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = this.server!.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${port}/realm`;
  }

  stop(): void {
    this.server?.close();
  }
}

const ENV = [
  'DM_JWT_ISSUER',
  'DM_JWT_JWKS_URI',
  'DM_JWT_AUDIENCES',
  'DM_JWT_ALGORITHMS',
  'DM_JWT_IDENTITY_CLAIM',
  'DM_JWT_ALLOWED_CLIENTS',
  'DM_JWT_TYPE',
  'DM_JWT_ISSUERS',
];

describe('core/auth/jwt', () => {
  const provider = new Provider();
  let signing: CryptoKey;
  let stranger: CryptoKey;
  /** Other algorithms, published under their own kid */
  const others: Record<string, CryptoKey> = {};

  const now = (): number => Math.floor(Date.now() / 1000);
  const sign = (
    claims: JWTPayload,
    key: CryptoKey = signing,
    header: { alg: string; kid?: string; typ?: string } = {
      alg: 'RS256',
      kid: 'k1',
    }
  ): Promise<string> =>
    new SignJWT({
      client_id: 'backup',
      iss: provider.issuer,
      aud: 'ldap-rest',
      iat: now(),
      exp: now() + 300,
      ...claims,
    })
      .setProtectedHeader(header)
      .sign(key);

  async function server(
    env: Record<string, string> = {}
  ): Promise<{ app: express.Express; dm: DM }> {
    for (const name of ENV) delete process.env[name];
    process.env.DM_JWT_ISSUER = provider.issuer;
    Object.assign(process.env, env);
    const dm = new DM();
    await dm.ready;
    await dm.registerPlugin('authJwt', new AuthJwt(dm));
    dm.app.get('/api/whoami', (req, res) => {
      const { user, userName, authenticators } = req as DmRequest;
      res.json({ user, userName, authenticators });
    });
    return { app: dm.app, dm };
  }

  const call = (app: express.Express, token?: string): request.Test => {
    const r = request(app).get('/api/whoami');
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  before(async () => {
    await provider.start();
    const pair = await generateKeyPair('RS256', { extractable: true });
    signing = pair.privateKey;
    provider.keys = [
      { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' },
    ];
    stranger = (await generateKeyPair('RS256')).privateKey;
    for (const alg of ['ES256', 'PS256', 'EdDSA']) {
      const other = await generateKeyPair(alg, { extractable: true });
      others[alg] = other.privateKey;
      provider.keys.push({
        ...(await exportJWK(other.publicKey)),
        kid: alg,
        alg,
      });
    }
  });

  after(() => {
    provider.stop();
    for (const name of ENV) delete process.env[name];
  });

  describe('through discovery', () => {
    let app: express.Express;
    before(async () => {
      ({ app } = await server({ DM_JWT_AUDIENCES: 'ldap-rest' }));
    });

    it('publishes the client of a valid token', async () => {
      const res = await call(app, await sign({})).expect(200);
      expect(res.body).to.deep.equal({
        user: 'backup',
        userName: 'backup',
        authenticators: ['authJwt'],
      });
    });

    it('asks for a bearer token when there is none', async () => {
      const res = await call(app).expect(401);
      expect(res.headers['www-authenticate']).to.equal('Bearer');
      await request(app)
        .get('/api/whoami')
        .set('Authorization', 'Basic YTpi')
        .expect(401);
    });

    const refused: Array<[string, () => Promise<string>]> = [
      ['an expired token', (): Promise<string> => sign({ exp: now() - 120 })],
      [
        'a token not valid yet',
        (): Promise<string> => sign({ nbf: now() + 120 }),
      ],
      [
        'a token from another issuer',
        (): Promise<string> =>
          new SignJWT({ client_id: 'backup' })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer('https://elsewhere.example')
            .setAudience('ldap-rest')
            .setExpirationTime('5m')
            .sign(signing),
      ],
      [
        'a token for another audience',
        (): Promise<string> => sign({ aud: 'other' }),
      ],
      [
        'a token without exp',
        (): Promise<string> =>
          new SignJWT({ client_id: 'backup' })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(provider.issuer)
            .setAudience('ldap-rest')
            .sign(signing),
      ],
      [
        'a token signed by another key',
        (): Promise<string> => sign({}, stranger),
      ],
      [
        'a token signed by another key under an unknown kid',
        (): Promise<string> => sign({}, stranger, { alg: 'RS256', kid: 'k2' }),
      ],
      [
        'an HMAC token',
        (): Promise<string> =>
          sign({}, new TextEncoder().encode('x'.repeat(32)) as never, {
            alg: 'HS256',
            kid: 'k1',
          }),
      ],
      [
        'an unsigned token',
        async (): Promise<string> =>
          [
            Buffer.from('{"alg":"none"}').toString('base64url'),
            Buffer.from(
              JSON.stringify({
                client_id: 'backup',
                iss: provider.issuer,
                aud: 'ldap-rest',
                exp: now() + 300,
              })
            ).toString('base64url'),
            '',
          ].join('.'),
      ],
      [
        'a token without client_id',
        (): Promise<string> => sign({ client_id: undefined }),
      ],
      ['a malformed token', async (): Promise<string> => 'not.a.jwt'],
    ];
    for (const [what, token] of refused)
      it(`refuses ${what}`, async () => {
        const res = await call(app, await token()).expect(401);
        expect(res.headers['www-authenticate']).to.equal(
          'Bearer error="invalid_token"'
        );
      });

    for (const alg of ['ES256', 'PS256', 'EdDSA'])
      it(`verifies a ${alg} token`, async () => {
        await call(app, await sign({}, others[alg], { alg, kid: alg })).expect(
          200
        );
      });

    it('tolerates a little clock skew', async () => {
      await call(app, await sign({ exp: now() - 10 })).expect(200);
    });
  });

  describe('configuration', () => {
    it('accepts any of several audiences', async () => {
      const { app } = await server({ DM_JWT_AUDIENCES: 'other;ldap-rest' });
      await call(app, await sign({})).expect(200);
      await call(app, await sign({ aud: 'third' })).expect(401);
    });

    it('reads discovery once', async () => {
      const { app } = await server();
      const hits = provider.discoveryHits;
      for (let i = 0; i < 3; i++) await call(app, await sign({})).expect(200);
      expect(provider.discoveryHits - hits).to.equal(1);
    });

    it('trims the allowed clients of JSON overrides', async () => {
      for (const name of ENV) delete process.env[name];
      process.env.DM_JWT_ISSUER = provider.issuer;
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin(
        'authJwt',
        new AuthJwt(
          dm.withConfig({
            ...dm.config,
            jwt_allowed_client: [' backup '],
          } as typeof dm.config)
        )
      );
      dm.app.get('/api/whoami', (req, res) => {
        res.json({ user: (req as DmRequest).user });
      });
      await call(dm.app, await sign({})).expect(200);
    });

    it('accepts ML-DSA when listed', async () => {
      for (const name of ENV) delete process.env[name];
      process.env.DM_JWT_ISSUER = provider.issuer;
      process.env.DM_JWT_ALGORITHMS = 'ML-DSA-44';
      const dm = new DM();
      await dm.ready;
      expect(() => new AuthJwt(dm)).to.not.throw();
    });

    it('reads another identity claim', async () => {
      const { app } = await server({ DM_JWT_IDENTITY_CLAIM: 'azp' });
      const res = await call(app, await sign({ azp: 'svc' })).expect(200);
      expect(res.body.user).to.equal('svc');
    });

    it('checks the token type when asked', async () => {
      const { app } = await server({ DM_JWT_TYPE: 'at+jwt' });
      await call(app, await sign({})).expect(401);
      await call(
        app,
        await sign({}, signing, { alg: 'RS256', kid: 'k1', typ: 'at+jwt' })
      ).expect(200);
    });

    it('trims an issuer read from a secret file', async () => {
      const { app } = await server({ DM_JWT_ISSUER: `${provider.issuer}\n` });
      await call(app, await sign({})).expect(200);
    });

    it('tries each key of a set without kid', async () => {
      const other = await generateKeyPair('RS256', { extractable: true });
      const saved = provider.keys;
      provider.keys = [
        { ...(await exportJWK(other.publicKey)), alg: 'RS256' },
        { ...saved[0], kid: undefined },
      ];
      try {
        const { app } = await server({
          DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
        });
        await call(app, await sign({}, signing, { alg: 'RS256' })).expect(200);
        await call(app, await sign({}, stranger, { alg: 'RS256' })).expect(401);
      } finally {
        provider.keys = saved;
      }
    });

    it('restricts access to the allowed clients', async () => {
      const { app } = await server({ DM_JWT_ALLOWED_CLIENTS: 'backup;sync' });
      await call(app, await sign({})).expect(200);
      await call(app, await sign({ client_id: 'intruder' })).expect(403);
    });

    it('takes the JWKS from --jwt-jwks-uri without discovery', async () => {
      provider.discoveryIssuer = 'https://not-this-one.example';
      try {
        const { app } = await server({
          DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
        });
        await call(app, await sign({})).expect(200);
      } finally {
        provider.discoveryIssuer = undefined;
      }
    });

    for (const [env, message] of [
      [{ DM_JWT_ALGORITHMS: 'RS256;HS256' }, 'HS256 refused'],
      [{ DM_JWT_ALGORITHMS: 'none' }, 'none refused'],
      [{ DM_JWT_ISSUER: '' }, '--jwt-issuer is required'],
      [{ DM_JWT_JWKS_URI: 'data:application/json,{}' }, 'not an http(s) URL'],
      [{ DM_JWT_IDENTITY_CLAIM: ' ' }, '--jwt-identity-claim is empty'],
    ] as Array<[Record<string, string>, string]>)
      it(`refuses to start on ${JSON.stringify(env)}`, async () => {
        for (const name of ENV) delete process.env[name];
        process.env.DM_JWT_ISSUER = provider.issuer;
        Object.assign(process.env, env);
        const dm = new DM();
        await dm.ready;
        expect(() => new AuthJwt(dm)).to.throw(message);
      });
  });

  describe('when the keys cannot be had', () => {
    afterEach(() => {
      AuthJwt.retryMs = 30_000;
      AuthJwt.remoteOptions = {};
      provider.jwksStatus = 200;
    });

    it('answers 503 while the JWKS fails, and recovers', async () => {
      AuthJwt.retryMs = 0;
      const { app } = await server({
        DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
      });
      provider.jwksStatus = 500;
      await call(app, await sign({})).expect(503);
      provider.jwksStatus = 200;
      await call(app, await sign({})).expect(200);
    });

    it('waits before fetching a failing JWKS again', async () => {
      const { app } = await server({
        DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
      });
      provider.jwksStatus = 500;
      const hits = provider.jwksHits;
      for (let i = 0; i < 5; i++) await call(app, await sign({})).expect(503);
      expect(provider.jwksHits - hits).to.equal(1);
    });

    it('keeps verifying with the keys it held while the JWKS fails', async () => {
      AuthJwt.remoteOptions = { cooldownDuration: 0 };
      const { app } = await server({
        DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
      });
      await call(app, await sign({})).expect(200);
      provider.jwksStatus = 500;
      // An unknown kid makes jose fetch again, and that fetch fails
      let hits = provider.jwksHits;
      await call(
        app,
        await sign({}, stranger, { alg: 'RS256', kid: 'rotated' })
      ).expect(401);
      expect(provider.jwksHits).to.equal(hits + 1);
      hits = provider.jwksHits;
      for (let i = 0; i < 3; i++) {
        await call(app, await sign({})).expect(200);
        await call(
          app,
          await sign({}, stranger, { alg: 'RS256', kid: `r${i}` })
        ).expect(401);
      }
      expect(provider.jwksHits).to.equal(hits);
    });

    it('refuses a malformed token without asking for the keys', async () => {
      const { app } = await server({
        DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
      });
      provider.jwksStatus = 500;
      const hits = provider.jwksHits;
      try {
        await call(app, 'not.a.jwt').expect(401);
        await call(
          app,
          await sign({}, new TextEncoder().encode('x'.repeat(32)) as never, {
            alg: 'HS256',
          })
        ).expect(401);
      } finally {
        provider.jwksStatus = 200;
      }
      expect(provider.jwksHits).to.equal(hits);
    });

    it('follows no redirect from discovery', async () => {
      provider.discoveryRedirect = `${provider.issuer}/elsewhere`;
      try {
        const { app } = await server();
        await call(app, await sign({})).expect(503);
      } finally {
        provider.discoveryRedirect = undefined;
      }
    });

    it('answers 503 when discovery names another issuer', async () => {
      provider.discoveryIssuer = 'https://impostor.example';
      try {
        const { app } = await server();
        await call(app, await sign({})).expect(503);
      } finally {
        provider.discoveryIssuer = undefined;
      }
    });

    it('does not fetch the keys again for every unknown kid', async () => {
      const { app } = await server();
      await call(app, await sign({})).expect(200);
      const hits = provider.jwksHits;
      for (let i = 0; i < 5; i++)
        await call(
          app,
          await sign({}, stranger, { alg: 'RS256', kid: `x${i}` })
        ).expect(401);
      expect(provider.jwksHits - hits).to.be.at.most(1);
    });
  });

  describe('with several issuers', () => {
    const second = new Provider();
    let secondKey: CryptoKey;

    before(async () => {
      await second.start();
      const pair = await generateKeyPair('ES256', { extractable: true });
      secondKey = pair.privateKey;
      second.keys = [
        { ...(await exportJWK(pair.publicKey)), kid: 'b1', alg: 'ES256' },
      ];
      secondKeys = second.keys;
    });

    after(() => second.stop());

    let secondKeys: JWK[];

    afterEach(() => {
      second.jwksStatus = 200;
      second.discoveryIssuer = undefined;
      second.keys = secondKeys;
    });

    const fromSecond = (claims: JWTPayload = {}): Promise<string> =>
      sign({ iss: second.issuer, ...claims }, secondKey, {
        alg: 'ES256',
        kid: 'b1',
      });

    /**
     * A server trusting both providers, prefixed `a:` and `b:`, the second
     * one with `entry`
     */
    async function both(
      entry: Record<string, unknown> = {},
      env: Record<string, string> = {}
    ): Promise<express.Express> {
      for (const name of ENV) delete process.env[name];
      process.env.DM_JWT_ISSUERS = JSON.stringify({
        [provider.issuer]: { identity_prefix: 'a:' },
        [second.issuer]: {
          algorithm: ['ES256'],
          identity_prefix: 'b:',
          ...entry,
        },
      });
      Object.assign(process.env, env);
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authJwt', new AuthJwt(dm));
      dm.app.get('/api/whoami', (req, res) => {
        res.json({ user: (req as DmRequest).user });
      });
      return dm.app;
    }

    it('accepts a token from each issuer', async () => {
      const app = await both();
      await call(app, await sign({})).expect(200);
      const res = await call(app, await fromSecond({ client_id: 'sync' }));
      expect(res.status).to.equal(200);
      expect(res.body.user).to.equal('b:sync');
    });

    it('judges a token with the keys of the issuer it names only', async () => {
      const app = await both({ algorithm: ['ES256', 'RS256'] });
      // The second provider publishes a key of its own under the first one's
      // kid: the first one's key would verify the token, were it tried
      const own = await generateKeyPair('RS256', { extractable: true });
      second.keys = [
        ...secondKeys,
        { ...(await exportJWK(own.publicKey)), kid: 'k1', alg: 'RS256' },
      ];
      await call(app, await sign({ iss: second.issuer })).expect(401);
      await call(
        app,
        await sign({ iss: second.issuer }, own.privateKey, {
          alg: 'RS256',
          kid: 'k1',
        })
      ).expect(200);
      await call(app, await sign({})).expect(200);
    });

    it('judges a token without kid with the keys of the issuer it names only', async () => {
      const app = await both({ algorithm: ['ES256', 'RS256'] });
      const own = await generateKeyPair('RS256', { extractable: true });
      second.keys = [
        ...secondKeys,
        { ...(await exportJWK(own.publicKey)), alg: 'RS256' },
      ];
      await call(
        app,
        await sign({ iss: second.issuer }, signing, { alg: 'RS256' })
      ).expect(401);
      await call(
        app,
        await sign({ iss: second.issuer }, own.privateKey, { alg: 'RS256' })
      ).expect(200);
      await call(app, await sign({}, signing, { alg: 'RS256' })).expect(200);
    });

    it('answers 503 only for an issuer whose discovery names another', async () => {
      const app = await both();
      second.discoveryIssuer = provider.issuer;
      await call(app, await fromSecond()).expect(503);
      await call(app, await sign({})).expect(200);
    });

    it('refuses an issuer it was not given, or no issuer, unfetched', async () => {
      const app = await both();
      const hits = provider.discoveryHits + second.discoveryHits;
      await call(app, await sign({ iss: 'https://other.example' })).expect(401);
      await call(app, await sign({ iss: undefined })).expect(401);
      expect(provider.discoveryHits + second.discoveryHits).to.equal(hits);
    });

    it("checks each issuer's own algorithms and audience", async () => {
      const app = await both(
        { audience: ['directory'] },
        { DM_JWT_AUDIENCES: 'ldap-rest', DM_JWT_ALGORITHMS: 'RS256' }
      );
      await call(app, await sign({})).expect(200);
      await call(app, await fromSecond()).expect(401);
      await call(app, await fromSecond({ aud: 'directory' })).expect(200);
      // ES256 is the second issuer's only
      await call(
        app,
        await sign({}, others.ES256, { alg: 'ES256', kid: 'ES256' })
      ).expect(401);
    });

    it("checks each issuer's own allowed clients", async () => {
      const app = await both(
        { allowed_client: ['sync'] },
        { DM_JWT_ALLOWED_CLIENTS: 'backup' }
      );
      await call(app, await sign({})).expect(200);
      await call(app, await fromSecond({ client_id: 'backup' })).expect(403);
      await call(app, await fromSecond({ client_id: 'sync' })).expect(200);
    });

    it('prefixes the identity of the issuer configured so', async () => {
      const app = await both({ identity_prefix: 'b:', identity_claim: 'sub' });
      const res = await call(app, await fromSecond({ sub: 'svc' })).expect(200);
      expect(res.body.user).to.equal('b:svc');
      const first = await call(app, await sign({})).expect(200);
      expect(first.body.user).to.equal('a:backup');
    });

    it('answers 503 only for the tokens of an issuer it cannot reach', async () => {
      const app = await both({ jwks_uri: `${second.issuer}/certs` });
      second.jwksStatus = 500;
      await call(app, await fromSecond()).expect(503);
      await call(app, await sign({})).expect(200);
    });

    it('refuses to start on a list of issuers', async () => {
      for (const name of ENV) delete process.env[name];
      process.env.DM_JWT_ISSUERS = '["https://a.example"]';
      const dm = new DM();
      await dm.ready;
      expect(() => new AuthJwt(dm)).to.throw(
        '--jwt-issuers must be a JSON object'
      );
    });

    for (const [issuers, env, message] of [
      [{ x: [] }, {}, 'must be a JSON object'],
      [
        { 'https://a.example': { audiences: ['a'] } },
        {},
        'unknown field "audiences"',
      ],
      [
        { 'https://a.example': { audience: 'a' } },
        {},
        '"audience" must be a list',
      ],
      [{ 'https://a.example': { algorithm: ['HS256'] } }, {}, 'HS256 refused'],
      [{ 'https://a.example ': {} }, {}, 'named exactly'],
      [{ 'ftp://a.example': {} }, {}, 'not an http(s) URL'],
      [
        { 'https://a.example': {} },
        { DM_JWT_ISSUER: 'https://b.example' },
        '--jwt-issuers replaces --jwt-issuer',
      ],
      // A's client "b:admin" would be taken for B's "admin"
      [
        {
          'https://a.example': {},
          'https://b.example': { identity_prefix: 'b:' },
        },
        {},
        '"https://a.example": identity_prefix is required',
      ],
      // A's "b:x" and B's "x" would both be "a:b:x"
      [
        {
          'https://a.example': { identity_prefix: 'a:' },
          'https://b.example': { identity_prefix: 'a:b:' },
        },
        {},
        'identity_prefix "a:b:" of https://b.example starts with "a:"',
      ],
      [
        {
          'https://a.example': { identity_prefix: 'x:' },
          'https://b.example': { identity_prefix: 'x:' },
        },
        {},
        'starts with "x:"',
      ],
    ] as Array<[Record<string, unknown>, Record<string, string>, string]>)
      it(`refuses to start on ${JSON.stringify(issuers)}`, async () => {
        for (const name of ENV) delete process.env[name];
        process.env.DM_JWT_ISSUERS = JSON.stringify(issuers);
        Object.assign(process.env, env);
        const dm = new DM();
        await dm.ready;
        expect(() => new AuthJwt(dm)).to.throw(message);
      });

    it('needs no prefix for a single issuer', async () => {
      for (const name of ENV) delete process.env[name];
      process.env.DM_JWT_ISSUERS = JSON.stringify({ [provider.issuer]: {} });
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('authJwt', new AuthJwt(dm));
      dm.app.get('/api/whoami', (req, res) => {
        res.json({ user: (req as DmRequest).user });
      });
      const res = await call(dm.app, await sign({})).expect(200);
      expect(res.body.user).to.equal('backup');
    });
  });
});
