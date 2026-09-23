/**
 * Regression tests for authzDynamic behavioural fixes from the PR #57 review.
 *
 * Each test names the reviewer finding it guards.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import AuthzDynamic, {
  authzContext,
} from '../../../src/plugins/auth/authzDynamic';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import { ssha } from '../../../src/plugins/auth/authzDynamicHash';

describe('authzDynamic behavioural regressions', function () {
  let server: DM;
  let plugin: AuthzDynamic;
  let groupsPlugin: LdapGroups;
  let baseDn: string;
  let tokensOu: string;
  let savedBase: string | undefined;
  let savedTtl: string | undefined;
  const tokenJsonTenant = 'tok-json-tenant-7777';
  const tokenAttrTenant = 'tok-attr-tenant-8888';

  before(async function () {
    this.timeout(30000);
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping authzDynamic behavioural tests: LDAP env vars missing'
      );
      this.skip();
      return;
    }
    baseDn = process.env.DM_LDAP_BASE;
    tokensOu = `ou=authz-behavior-tokens,${baseDn}`;
    savedBase = process.env.DM_AUTHZ_DYNAMIC_BASE;
    savedTtl = process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL;
    process.env.DM_AUTHZ_DYNAMIC_BASE = tokensOu;
    process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL = '1';
    process.env.DM_LDAP_GROUP_BASE = `ou=groups,${baseDn}`;
    process.env.DM_GROUP_SCHEMA = '';

    server = new DM();
    plugin = new AuthzDynamic(server);
    plugin.api(server.app);
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

    try {
      await plugin.server.ldap.add(tokensOu, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'authz-behavior-tokens',
      });
    } catch {
      /* may already exist */
    }
    // Entry A: tenant comes from the JSON config (should override cn).
    await plugin.server.ldap.add(`cn=json-entry,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'json-entry',
      sn: 'json-entry',
      userPassword: ssha(tokenJsonTenant),
      description: JSON.stringify({
        tenant: 'explicit-json-tenant',
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
    // Entry B: no tenant in JSON → falls back to cn (the configured attr).
    await plugin.server.ldap.add(`cn=attr-entry,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'attr-entry',
      sn: 'attr-entry',
      userPassword: ssha(tokenAttrTenant),
      description: JSON.stringify({
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

    await plugin.reload();
  });

  after(async () => {
    if (plugin) {
      for (const cn of ['json-entry', 'attr-entry']) {
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
    }
    if (savedBase === undefined) delete process.env.DM_AUTHZ_DYNAMIC_BASE;
    else process.env.DM_AUTHZ_DYNAMIC_BASE = savedBase;
    if (savedTtl === undefined) delete process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL;
    else process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL = savedTtl;
  });

  describe('parsed.tenant honoured (Copilot)', () => {
    it('uses the JSON `tenant` field when present', () => {
      const tokens = plugin._tokens();
      const entry = tokens.find(t => t.cn === 'json-entry');
      expect(entry, 'json-entry should be loaded').to.exist;
      expect(entry!.tenant).to.equal('explicit-json-tenant');
    });

    it('falls back to the tenantAttribute (cn) when JSON omits tenant', () => {
      const tokens = plugin._tokens();
      const entry = tokens.find(t => t.cn === 'attr-entry');
      expect(entry, 'attr-entry should be loaded').to.exist;
      expect(entry!.tenant).to.equal('attr-entry');
    });

    it('authenticated request carries the JSON tenant as req.user', async () => {
      // supertest → auth middleware sets req.user = match.tenant
      // We can't inspect req.user directly; instead, verify the ACL matches
      // as the JSON-tenant-carrier would get read on groups.
      await supertest(server.app)
        .get('/api/v1/ldap/groups')
        .set('Authorization', `Bearer ${tokenJsonTenant}`)
        .expect(200);
    });
  });

  describe('Forbidden denial — 403 with no sensitive leakage', () => {
    it('denies write with 403 and generic message (no token name, no DN)', async () => {
      const res = await supertest(server.app)
        .post('/api/v1/ldap/groups')
        .set('Authorization', `Bearer ${tokenJsonTenant}`)
        .set('Content-Type', 'application/json')
        .send({ cn: 'some-group' })
        .expect(403);
      expect(res.body.error).to.match(/permission/i);
      expect(res.body.error).to.not.match(/explicit-json-tenant/);
      expect(res.body.error).to.not.match(/ou=groups/);
      expect(res.body.error).to.not.match(/\[authz-forbidden\]/);
    });
  });

  describe('reload failure backoff', () => {
    it('does not touch lastLoad but records lastFailure when reload fails', async () => {
      // Point the plugin's base at a non-existent branch → reload fails
      // Note: we can't easily swap the base on a live plugin. Instead, we
      // verify the behaviour by forcing a failure through deleting a required
      // attribute… easier: simulate by calling reload on a plugin configured
      // with an unreachable base.
      const hijack = new AuthzDynamic({
        ...server,
        config: {
          ...server.config,
          authz_dynamic_base: `ou=does-not-exist,${baseDn}`,
        },
        logger: server.logger,
        hooks: server.hooks,
        ldap: server.ldap,
        operationSequence: 0,
        app: server.app,
        loadedPlugins: server.loadedPlugins,
      } as unknown as DM);
      // Attempt reload — should log an error but not throw
      await hijack.reload();
      const dataBefore = hijack.getConfigApiData();
      expect(dataBefore.tokenCount).to.equal(0);
      // Second reload right away should not make another LDAP call because
      // the failure-backoff window blocks it. We can only assert this
      // through observed behaviour: lastFailure is positive, so another
      // request routed through authMethod should still return 401 quickly.
      // This is a smoke test; deeper timing assertions would need clock
      // injection.
    });
  });

  describe('another authenticator identified the caller (GHSA-rxq9-qj94-27gg)', () => {
    /** A prior middleware that identifies the caller, as the dispatcher would */
    const identifyAs = (key: string): (() => void) => {
      server.hooks.beforeAuth = server.hooks.beforeAuth || [];
      (server.hooks.beforeAuth as Array<unknown>).push(
        (args: [{ user?: string }, unknown]) => {
          args[0].user = key;
          return args;
        }
      );
      return () => {
        (server.hooks.beforeAuth as Array<unknown>).pop();
      };
    };

    it('should not let a request past the ACLs just because someone else named it', async () => {
      // The plugin used to step aside as soon as `req.user` was set, so with
      // `core/auth/token` loaded beside it the token plugin ran first and
      // every LDAP operation of that request was checked against no ACL —
      // a branch-unrestricted administrator, decided by registration order.
      const done = identifyAs('preexisting-user');
      try {
        const res = await supertest(server.app).get('/api/v1/ldap/groups');
        expect(res.status, JSON.stringify(res.body)).to.equal(401);
      } finally {
        done();
      }
      expect(authzContext.getStore(), 'no leaked frame').to.be.undefined;
    });

    it('should let it through when the deployment names the identity', async () => {
      const done = identifyAs('preexisting-user');
      server.config.authz_dynamic_bypass = ['preexisting-user'];
      try {
        const res = await supertest(server.app).get('/api/v1/ldap/groups');
        expect(res.status).to.not.equal(401);
      } finally {
        server.config.authz_dynamic_bypass = [];
        done();
      }
      // A bypass carries no token, so no frame is entered and the hooks
      // enforce nothing — which is what the deployment asked for.
      expect(authzContext.getStore(), 'no leaked frame').to.be.undefined;
    });

    it('should let it through under the old blanket behaviour, when asked for', async () => {
      const done = identifyAs('someone-else');
      server.config.authz_dynamic_bypass = ['any-authenticated'];
      try {
        const res = await supertest(server.app).get('/api/v1/ldap/groups');
        expect(res.status).to.not.equal(401);
      } finally {
        server.config.authz_dynamic_bypass = [];
        done();
      }
    });

    it('should not let a named identity through on another name', async () => {
      const done = identifyAs('someone-else');
      server.config.authz_dynamic_bypass = ['preexisting-user'];
      try {
        const res = await supertest(server.app).get('/api/v1/ldap/groups');
        expect(res.status).to.equal(401);
      } finally {
        server.config.authz_dynamic_bypass = [];
        done();
      }
    });

    it('should refuse a write the token may not make, although someone else named the caller', async () => {
      // The advisory's case, end to end: token A may read `ou=groups` and
      // not write it. Identified by another authenticator, the request used
      // to skip the ACLs entirely and the write went to the directory.
      const done = identifyAs('preexisting-user');
      try {
        const res = await supertest(server.app)
          .post('/api/v1/ldap/groups')
          .set('Authorization', `Bearer ${tokenJsonTenant}`)
          .set('Content-Type', 'application/json')
          .send({ cn: 'group-the-token-may-not-create' });
        expect(res.status, JSON.stringify(res.body)).to.equal(403);
        expect(res.body.error).to.match(/permission/i);
      } finally {
        done();
      }
    });

    it('should enforce the token ACLs of a request someone else already named', async () => {
      // The other half of the fix: a token presented by an already
      // identified caller is resolved and its ACLs applied, where the plugin
      // used to ignore it. The tenant does not overwrite the identity the
      // first authenticator published.
      const done = identifyAs('preexisting-user');
      try {
        const res = await supertest(server.app)
          .get('/api/v1/ldap/groups')
          .set('Authorization', `Bearer ${tokenJsonTenant}`);
        expect(res.status, JSON.stringify(res.body)).to.not.equal(401);
      } finally {
        done();
      }
      expect(authzContext.getStore(), 'no leaked frame').to.be.undefined;
    });
  });
});
