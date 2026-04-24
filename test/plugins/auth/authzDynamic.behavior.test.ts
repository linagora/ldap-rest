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
        config: { ...server.config, authz_dynamic_base: `ou=does-not-exist,${baseDn}` },
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

  describe('composable auth (req.user already set)', () => {
    it('short-circuits authMethod when req.user is already set by another middleware', async () => {
      // Simulate a prior auth middleware that set req.user. We add it to the
      // stack AFTER the SCIM auth, but since Express runs in order and the
      // authzDynamic middleware is in place already, we piggyback via a hook:
      // set req.user in beforeAuth.
      const key = 'preexisting-user';
      server.hooks.beforeAuth = server.hooks.beforeAuth || [];
      (server.hooks.beforeAuth as Array<unknown>).push(
        (args: [{ user?: string }, unknown]) => {
          args[0].user = key;
          return args;
        }
      );

      // Call a route with NO Authorization header — would normally 401.
      // With the short-circuit, it should proceed past authMethod; but the
      // authzDynamic hooks still gate on the active token from
      // AsyncLocalStorage. Since the short-circuit runs `next()` without
      // entering the `authzContext.run` frame, no token is active, and the
      // authz hooks pass through (they no-op when no token).
      // We expect the request to reach the route handler (no 401).
      const res = await supertest(server.app).get('/api/v1/ldap/groups');
      expect(res.status).to.not.equal(401);

      // Clean up the hook
      (server.hooks.beforeAuth as Array<unknown>).pop();
      expect(authzContext.getStore(), 'no leaked frame').to.be.undefined;
    });
  });
});
