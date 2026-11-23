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
  jwksHits = 0;
  private server?: Server;

  async start(): Promise<void> {
    const app = express();
    app.get('/realm/.well-known/openid-configuration', (_req, res) => {
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
];

describe('core/auth/jwt', () => {
  const provider = new Provider();
  let signing: CryptoKey;
  let stranger: CryptoKey;

  const now = (): number => Math.floor(Date.now() / 1000);
  const sign = (
    claims: JWTPayload,
    key: CryptoKey = signing,
    header: { alg: string; kid?: string } = { alg: 'RS256', kid: 'k1' }
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

    it('tolerates a little clock skew', async () => {
      await call(app, await sign({ exp: now() - 10 })).expect(200);
    });
  });

  describe('configuration', () => {
    it('reads another identity claim', async () => {
      const { app } = await server({ DM_JWT_IDENTITY_CLAIM: 'azp' });
      const res = await call(app, await sign({ azp: 'svc' })).expect(200);
      expect(res.body.user).to.equal('svc');
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
    it('answers 503 while the JWKS fails, and recovers', async () => {
      const { app } = await server({
        DM_JWT_JWKS_URI: `${provider.issuer}/certs`,
      });
      provider.jwksStatus = 500;
      try {
        await call(app, await sign({})).expect(503);
      } finally {
        provider.jwksStatus = 200;
      }
      await call(app, await sign({})).expect(200);
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
});
