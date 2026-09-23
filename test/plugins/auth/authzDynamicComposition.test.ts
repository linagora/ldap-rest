/**
 * `authzDynamic` beside another authenticator (GHSA-rxq9-qj94-27gg).
 *
 * The dispatcher runs every authenticator claiming the winning prefix, in
 * registration order. `authzDynamic` used to step aside as soon as one of
 * them had set `req.user`, so `core/auth/token` registered first meant its
 * static tokens reached the directory with no ACL at all — and registered
 * second, the same configuration demanded both credentials. Which of the two
 * a deployment got was import-completion order, not a decision.
 *
 * Both orders are built here, and asserted to answer the same thing.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import AuthzDynamic from '../../../src/plugins/auth/authzDynamic';
import AuthToken from '../../../src/plugins/auth/token';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { ssha } from '../../../src/plugins/auth/authzDynamicHash';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

const STATIC_TOKEN = 'static-token-for-composition';
const STATIC_USER = 'static-admin';
const DYNAMIC_TOKEN = 'dynamic-token-for-composition';

describe('authzDynamic loaded beside another authenticator', function () {
  let baseDn: string;
  let tokensOu: string;
  let fixtureServer: DM;
  const saved: Record<string, string | undefined> = {};

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    baseDn = process.env.DM_LDAP_BASE as string;
    tokensOu = `ou=authz-composition-tokens,${baseDn}`;
    for (const k of [
      'DM_AUTHZ_DYNAMIC_BASE',
      'DM_AUTHZ_DYNAMIC_CACHE_TTL',
      'DM_AUTH_TOKENS',
      'DM_AUTHZ_DYNAMIC_BYPASS',
    ])
      saved[k] = process.env[k];
    process.env.DM_AUTHZ_DYNAMIC_BASE = tokensOu;
    process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL = '1';
    process.env.DM_AUTH_TOKENS = `${STATIC_TOKEN}:${STATIC_USER}`;
    delete process.env.DM_AUTHZ_DYNAMIC_BYPASS;

    fixtureServer = new DM();
    await fixtureServer.ready;
    await fixtureServer.ldap
      .add(tokensOu, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'authz-composition-tokens',
      })
      .catch(() => undefined);
    await fixtureServer.ldap
      .add(`cn=reader,${tokensOu}`, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'reader',
        sn: 'reader',
        userPassword: ssha(DYNAMIC_TOKEN),
        description: JSON.stringify({
          tenant: 'composition-tenant',
          bases: [
            {
              dn: `ou=groups,${baseDn}`,
              read: true,
              write: false,
              delete: false,
            },
          ],
        }),
      })
      .catch(() => undefined);
  });

  after(async () => {
    await fixtureServer?.ldap
      .delete(`cn=reader,${tokensOu}`)
      .catch(() => undefined);
    await fixtureServer?.ldap.delete(tokensOu).catch(() => undefined);
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  /** A server loading both authenticators, in the order given */
  const build = async (
    tokenFirst: boolean,
    bypass: string[] = []
  ): Promise<ReturnType<typeof supertest>> => {
    const server = new DM();
    await server.ready;
    server.config.authz_dynamic_bypass = bypass;
    const token = new AuthToken(server);
    const dynamic = new AuthzDynamic(server);
    if (tokenFirst) {
      await server.registerPlugin('authToken', token);
      await server.registerPlugin('authzDynamic', dynamic);
    } else {
      await server.registerPlugin('authzDynamic', dynamic);
      await server.registerPlugin('authToken', token);
    }
    await dynamic.reload();
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    server.setupErrorMiddleware();
    return supertest(server.app);
  };

  for (const tokenFirst of [true, false]) {
    const order = tokenFirst ? 'token first' : 'authzDynamic first';

    it(`should refuse a static token that carries no ACL (${order})`, async () => {
      const request = await build(tokenFirst);
      const res = await request
        .get('/api/v1/ldap/groups')
        .set('Authorization', `Bearer ${STATIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(401);
    });

    it(`should let the static token through when the deployment says so (${order})`, async () => {
      const request = await build(tokenFirst, [STATIC_USER]);
      const res = await request
        .get('/api/v1/ldap/groups')
        .set('Authorization', `Bearer ${STATIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.not.equal(401);
      expect(res.status).to.not.equal(403);
    });

    it(`should keep the dynamic token's own path working (${order})`, async () => {
      // With both authenticators unscoped the dispatcher demands both, so a
      // request carrying only the dynamic token is refused by the token
      // plugin — before this fix it was refused in one registration order
      // and accepted, ACL-free, in the other. The ACLs themselves are
      // exercised in `authzDynamic.behavior.test.ts`, where the second
      // identity comes from a hook rather than from a second credential.
      const request = await build(tokenFirst);
      const res = await request
        .get('/api/v1/ldap/groups')
        .set('Authorization', `Bearer ${DYNAMIC_TOKEN}`);
      expect(res.status, JSON.stringify(res.body)).to.equal(401);
    });
  }
});
