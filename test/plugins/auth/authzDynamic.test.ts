import { expect } from 'chai';
import supertest from 'supertest';

import AuthzDynamic from '../../../src/plugins/auth/authzDynamic';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import { ssha } from '../../../src/plugins/auth/authzDynamicHash';

describe('authzDynamic (integration)', function () {
  let server: DM;
  let plugin: AuthzDynamic;
  let groupsPlugin: LdapGroups;
  let baseDn: string;
  let tokensOu: string;
  const validToken = 'unit-test-secret-4242';
  const foreignToken = 'foreign-secret-1111';

  before(async function () {
    this.timeout(30000);
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn('Skipping authzDynamic tests: LDAP env vars missing');
      this.skip();
      return;
    }
    baseDn = process.env.DM_LDAP_BASE;
    tokensOu = `ou=authz-tokens,${baseDn}`;

    process.env.DM_AUTHZ_DYNAMIC_BASE = tokensOu;
    process.env.DM_LDAP_GROUP_BASE = `ou=groups,${baseDn}`;
    // Disable the Twake group schema so the plain CRUD works in this test.
    process.env.DM_GROUP_SCHEMA = '';
    // Short TTL so tests see reloads promptly
    process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL = '1';

    server = new DM();
    plugin = new AuthzDynamic(server);
    plugin.api(server.app);
    // Register the plugin's hooks with the server (the plugin loader normally
    // does this when plugins are loaded via --plugin; here we instantiate
    // directly so we have to wire hooks ourselves).
    if (plugin.hooks) {
      for (const [name, fn] of Object.entries(plugin.hooks)) {
        if (!fn) continue;
        const list = (server.hooks[name] =
          server.hooks[name] || ([] as unknown[] as never));
        (list as unknown as Array<unknown>).push(fn as unknown);
      }
    }
    groupsPlugin = new LdapGroups(server);
    groupsPlugin.api(server.app);
    if (groupsPlugin.hooks) {
      for (const [name, fn] of Object.entries(groupsPlugin.hooks)) {
        if (!fn) continue;
        const list = (server.hooks[name] =
          server.hooks[name] || ([] as unknown[] as never));
        (list as unknown as Array<unknown>).push(fn as unknown);
      }
    }
    server.loadedPlugins['authzDynamic'] = plugin;
    server.loadedPlugins['ldapGroups'] = groupsPlugin;
    await server.ready;

    // Create tokens OU + two token entries: one allowed on groups, one foreign
    try {
      await plugin.server.ldap.add(tokensOu, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'authz-tokens',
      });
    } catch {
      /* may already exist */
    }
    await plugin.server.ldap.add(`cn=allowed,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'allowed',
      sn: 'allowed',
      userPassword: ssha(validToken),
      description: JSON.stringify({
        tenant: 'allowed',
        bases: [
          {
            dn: `ou=groups,${baseDn}`,
            read: true,
            write: true,
            delete: true,
          },
        ],
      }),
    });
    await plugin.server.ldap.add(`cn=foreign,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'foreign',
      sn: 'foreign',
      userPassword: ssha(foreignToken),
      description: JSON.stringify({
        tenant: 'foreign',
        bases: [
          {
            dn: `ou=users,${baseDn}`, // explicitly NOT groups
            read: true,
            write: true,
            delete: true,
          },
        ],
      }),
    });

    // Force reload now (constructor did not run one yet)
    await plugin.reload();
  });

  after(async () => {
    if (!plugin) return;
    for (const cn of ['allowed', 'foreign']) {
      try {
        await plugin.server.ldap.delete(`cn=${cn},${tokensOu}`);
      } catch {
        /* ignore */
      }
    }
    try {
      await plugin.server.ldap.delete(tokensOu);
    } catch {
      /* ignore */
    }
  });

  afterEach(async () => {
    try {
      await plugin.server.ldap.delete(`cn=probe-group,ou=groups,${baseDn}`);
    } catch {
      /* ignore */
    }
  });

  it('rejects requests without a Bearer token', async () => {
    await supertest(server.app)
      .get('/api/v1/ldap/groups')
      .expect(401);
  });

  it('rejects requests with an unknown token', async () => {
    await supertest(server.app)
      .get('/api/v1/ldap/groups')
      .set('Authorization', 'Bearer this-token-does-not-exist')
      .expect(401);
  });

  it('authorizes a listing on a permitted branch', async () => {
    await supertest(server.app)
      .get('/api/v1/ldap/groups')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200);
  });

  it('forbids a listing on a branch outside the token ACL with 403', async () => {
    const res = await supertest(server.app)
      .get('/api/v1/ldap/groups')
      .set('Authorization', `Bearer ${foreignToken}`)
      .expect(403);
    expect(res.body.error).to.match(/permission/i);
    // Never leak the tenant name or target DN in the client-facing message
    expect(res.body.error).to.not.match(/foreign/);
    expect(res.body.error).to.not.match(/ou=/);
  });

  it('allows a write on a permitted branch', async () => {
    await supertest(server.app)
      .post('/api/v1/ldap/groups')
      .set('Authorization', `Bearer ${validToken}`)
      .set('Content-Type', 'application/json')
      .send({ cn: 'probe-group' })
      .expect(200);
  });

  it('forbids a write on a branch outside the token ACL with 403', async () => {
    const res = await supertest(server.app)
      .post('/api/v1/ldap/groups')
      .set('Authorization', `Bearer ${foreignToken}`)
      .set('Content-Type', 'application/json')
      .send({ cn: 'should-not-be-created' })
      .expect(403);
    expect(res.body.error).to.match(/permission/i);
  });

  it('exposes a stable token count via getConfigApiData()', () => {
    const data = plugin.getConfigApiData();
    expect(data.enabled).to.be.true;
    expect(data.tokenCount).to.equal(2);
    expect(data.base).to.equal(tokensOu);
  });

  it('picks up a new token after a reload', async () => {
    const rolling = 'rolling-token-xxx';
    await plugin.server.ldap.add(`cn=rolling,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'rolling',
      sn: 'rolling',
      userPassword: ssha(rolling),
      description: JSON.stringify({
        tenant: 'rolling',
        bases: [
          {
            dn: `ou=groups,${baseDn}`,
            read: true,
            write: false,
            delete: false,
          },
        ],
      }),
    });
    try {
      await plugin.reload();
      await supertest(server.app)
        .get('/api/v1/ldap/groups')
        .set('Authorization', `Bearer ${rolling}`)
        .expect(200);
    } finally {
      await plugin.server.ldap
        .delete(`cn=rolling,${tokensOu}`)
        .catch(() => {});
      await plugin.reload();
    }
  });
});
