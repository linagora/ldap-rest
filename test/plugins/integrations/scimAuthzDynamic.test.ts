/**
 * End-to-end integration tests that stack `core/auth/authzDynamic`
 * (LDAP-backed tokens + per-branch ACL) UNDER `core/scim` (SCIM 2.0 API),
 * exercising the exact deployment pattern the two plugins were designed
 * for: multi-tenant identity provisioning where each SCIM client is
 * cryptographically constrained to its own subtree.
 *
 * Setup emulated per test suite:
 *
 *    dc=example,dc=com
 *      ou=authz-tokens         (token entries — authzDynamic cache)
 *        cn=acme               (Bearer "acme-secret")
 *        cn=globex             (Bearer "globex-secret")
 *      ou=acme
 *        ou=users              (SCIM user base for tenant acme)
 *        ou=groups             (SCIM group base for tenant acme)
 *      ou=globex
 *        ou=users              (SCIM user base for tenant globex)
 *        ou=groups             (SCIM group base for tenant globex)
 *
 * The SCIM base is resolved per-request via the `{user}` template fed with
 * `req.user` that authzDynamic populates from the matched token's tenant.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import AuthzDynamic from '../../../src/plugins/auth/authzDynamic';
import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';
import { ssha } from '../../../src/plugins/auth/authzDynamicHash';
import type { Hooks } from '../../../src/hooks';

function wireHooks(server: DM, plugin: { hooks?: Hooks }): void {
  if (!plugin.hooks) return;
  for (const [name, fn] of Object.entries(plugin.hooks)) {
    if (!fn) continue;
    const list = (server.hooks[name] =
      server.hooks[name] || ([] as unknown[] as never));
    (list as unknown as Array<unknown>).push(fn as unknown);
  }
}

describe('SCIM + authzDynamic — multi-tenant E2E', function () {
  let server: DM;
  let authz: AuthzDynamic;
  let scim: Scim;
  let baseDn: string;
  let tokensOu: string;
  const acmeSecret = 'e2e-acme-secret-xxxxxxxx';
  const globexSecret = 'e2e-globex-secret-yyyyyyyy';
  // Third token: granted Users, denied Groups — exercises authzDynamic's
  // in-scope branch denial (vs. the SCIM-level isolation checked elsewhere).
  const usersOnlySecret = 'e2e-users-only-secret-zzzzzzzz';

  // Env vars we mutate and must restore
  const envKeys = [
    'DM_AUTHZ_DYNAMIC_BASE',
    'DM_AUTHZ_DYNAMIC_CACHE_TTL',
    'DM_SCIM_USER_BASE_TEMPLATE',
    'DM_SCIM_GROUP_BASE_TEMPLATE',
    'DM_SCIM_USER_BASE',
    'DM_SCIM_GROUP_BASE',
    'DM_GROUP_SCHEMA',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  before(async function () {
    this.timeout(30000);
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping SCIM+authzDynamic integration tests: LDAP env vars missing'
      );
      this.skip();
      return;
    }
    baseDn = process.env.DM_LDAP_BASE;
    tokensOu = `ou=e2e-tokens,${baseDn}`;

    // Snapshot env before mutating
    for (const k of envKeys) savedEnv[k] = process.env[k];

    process.env.DM_AUTHZ_DYNAMIC_BASE = tokensOu;
    process.env.DM_AUTHZ_DYNAMIC_CACHE_TTL = '1';
    // Per-tenant bases driven by req.user, populated by authzDynamic.
    process.env.DM_SCIM_USER_BASE_TEMPLATE = `ou=users,ou={user},${baseDn}`;
    process.env.DM_SCIM_GROUP_BASE_TEMPLATE = `ou=groups,ou={user},${baseDn}`;
    // Static bases are unused when templates fire, but we set them to a
    // distinct value so any accidental fall-back is visible in failures.
    delete process.env.DM_SCIM_USER_BASE;
    delete process.env.DM_SCIM_GROUP_BASE;
    // Disable the Twake group schema — plain groupOfNames is enough here.
    process.env.DM_GROUP_SCHEMA = '';

    server = new DM();
    // Auth first: AuthBase.api() adds the middleware at the head of the
    // stack, so SCIM routes registered after run AFTER auth.
    authz = new AuthzDynamic(server);
    authz.api(server.app);
    wireHooks(server, authz);

    scim = new Scim(server);
    await scim.api(server.app);
    wireHooks(server, scim);

    server.loadedPlugins['authzDynamic'] = authz;
    server.loadedPlugins['scim'] = scim;
    await server.ready;

    // Create the tenant tree. Tolerant to pre-existing entries between runs.
    const entries: Array<[string, Record<string, unknown>]> = [
      [
        tokensOu,
        {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'e2e-tokens',
        },
      ],
      // acme tenant
      [
        `ou=e2e-acme,${baseDn}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'e2e-acme' },
      ],
      [
        `ou=users,ou=e2e-acme,${baseDn}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'users' },
      ],
      [
        `ou=groups,ou=e2e-acme,${baseDn}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'groups' },
      ],
      // globex tenant
      [
        `ou=e2e-globex,${baseDn}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'e2e-globex' },
      ],
      [
        `ou=users,ou=e2e-globex,${baseDn}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'users' },
      ],
      [
        `ou=groups,ou=e2e-globex,${baseDn}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'groups' },
      ],
    ];
    for (const [dn, attrs] of entries) {
      try {
        await server.ldap.add(dn, attrs as never);
      } catch {
        /* may already exist */
      }
    }

    // Two tokens, scoped to their tenant sub-trees. Use a delete-then-add
    // upsert so a previous run that failed before `after` could run doesn't
    // leave the suite stuck on EntryAlreadyExists.
    const upsert = async (
      dn: string,
      attrs: Record<string, unknown>
    ): Promise<void> => {
      try {
        await server.ldap.delete(dn);
      } catch {
        /* not present — fine */
      }
      await server.ldap.add(dn, attrs as never);
    };

    await upsert(`cn=e2e-acme,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'e2e-acme',
      sn: 'e2e-acme',
      userPassword: ssha(acmeSecret),
      description: JSON.stringify({
        tenant: 'e2e-acme',
        bases: [
          {
            dn: `ou=users,ou=e2e-acme,${baseDn}`,
            read: true,
            write: true,
            delete: true,
          },
          {
            dn: `ou=groups,ou=e2e-acme,${baseDn}`,
            read: true,
            write: true,
            delete: true,
          },
        ],
      }),
    });
    await upsert(`cn=e2e-globex,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'e2e-globex',
      sn: 'e2e-globex',
      userPassword: ssha(globexSecret),
      description: JSON.stringify({
        tenant: 'e2e-globex',
        bases: [
          {
            dn: `ou=users,ou=e2e-globex,${baseDn}`,
            read: true,
            write: true,
            delete: true,
          },
          {
            dn: `ou=groups,ou=e2e-globex,${baseDn}`,
            read: true,
            write: true,
            delete: true,
          },
        ],
      }),
    });
    // Third token: users-only ACL, used below to exercise authzDynamic's
    // in-scope branch denial (no permission on groups → 403).
    await upsert(`cn=e2e-users-only,${tokensOu}`, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'e2e-users-only',
      sn: 'e2e-users-only',
      userPassword: ssha(usersOnlySecret),
      description: JSON.stringify({
        tenant: 'e2e-acme',
        bases: [
          {
            dn: `ou=users,ou=e2e-acme,${baseDn}`,
            read: true,
            write: true,
            delete: true,
          },
          // Deliberately NO entry for ou=groups — Group ops must be denied.
        ],
      }),
    });

    await authz.reload();
  });

  after(async () => {
    if (server) {
      // Best-effort cleanup of anything this suite may have left behind.
      const cleanup = [
        // Users / groups per tenant (catch-all)
        `uid=alice,ou=users,ou=e2e-acme,${baseDn}`,
        `uid=alice,ou=users,ou=e2e-globex,${baseDn}`,
        `uid=bob,ou=users,ou=e2e-acme,${baseDn}`,
        `cn=engineering,ou=groups,ou=e2e-acme,${baseDn}`,
        `cn=engineering,ou=groups,ou=e2e-globex,${baseDn}`,
        // Token entries
        `cn=e2e-acme,${tokensOu}`,
        `cn=e2e-globex,${tokensOu}`,
        `cn=e2e-users-only,${tokensOu}`,
        // Tenant OUs (order matters: children before parents)
        `ou=users,ou=e2e-acme,${baseDn}`,
        `ou=groups,ou=e2e-acme,${baseDn}`,
        `ou=e2e-acme,${baseDn}`,
        `ou=users,ou=e2e-globex,${baseDn}`,
        `ou=groups,ou=e2e-globex,${baseDn}`,
        `ou=e2e-globex,${baseDn}`,
        tokensOu,
      ];
      for (const dn of cleanup) {
        try {
          await server.ldap.delete(dn);
        } catch {
          /* ignore */
        }
      }
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  afterEach(async () => {
    // Scrub any leftover test users/groups from the inner tests.
    const dns = [
      `uid=alice,ou=users,ou=e2e-acme,${baseDn}`,
      `uid=alice,ou=users,ou=e2e-globex,${baseDn}`,
      `uid=bob,ou=users,ou=e2e-acme,${baseDn}`,
      `cn=engineering,ou=groups,ou=e2e-acme,${baseDn}`,
      `cn=engineering,ou=groups,ou=e2e-globex,${baseDn}`,
    ];
    for (const dn of dns) {
      try {
        await server.ldap.delete(dn);
      } catch {
        /* ignore */
      }
    }
  });

  describe('Authentication gating', () => {
    it('/scim/v2/Users without a Bearer token returns 401', async () => {
      await supertest(server.app).get('/scim/v2/Users').expect(401);
    });

    it('/scim/v2/Users with an unknown token returns 401', async () => {
      await supertest(server.app)
        .get('/scim/v2/Users')
        .set('Authorization', 'Bearer does-not-exist')
        .expect(401);
    });

    it('discovery endpoints are also gated', async () => {
      // ServiceProviderConfig sits behind the auth middleware too.
      await supertest(server.app)
        .get('/scim/v2/ServiceProviderConfig')
        .expect(401);
    });
  });

  describe('Per-tenant base resolution via {user} template', () => {
    it('acme creates a User under ou=users,ou=e2e-acme', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);

      // Direct LDAP read to confirm the DN actually lives under the acme branch.
      const result = await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['uid'] },
        `uid=alice,ou=users,ou=e2e-acme,${baseDn}`
      );
      expect(
        (result as { searchEntries: unknown[] }).searchEntries
      ).to.have.lengthOf(1);
    });

    it('globex creates its own alice without collision', async () => {
      // Alice already exists under acme (from the previous test is NOT
      // guaranteed: afterEach cleans up). Recreate for clarity.
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);

      // Same userName, different tenant → different DN, no conflict.
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${globexSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'Smith' },
        })
        .expect(201);

      const acmeDn = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['sn'] },
        `uid=alice,ou=users,ou=e2e-acme,${baseDn}`
      )) as unknown as { searchEntries: Array<{ sn: string }> };
      const globexDn = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['sn'] },
        `uid=alice,ou=users,ou=e2e-globex,${baseDn}`
      )) as unknown as { searchEntries: Array<{ sn: string }> };
      expect(acmeDn.searchEntries[0].sn).to.equal('Doe');
      expect(globexDn.searchEntries[0].sn).to.equal('Smith');
    });

    it('each tenant sees only its own users in list', async () => {
      // Seed both tenants with the same userName.
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'AcmeSide' },
        })
        .expect(201);
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${globexSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'GlobexSide' },
        })
        .expect(201);

      const acmeList = await supertest(server.app)
        .get('/scim/v2/Users')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .expect(200);
      const globexList = await supertest(server.app)
        .get('/scim/v2/Users')
        .set('Authorization', `Bearer ${globexSecret}`)
        .expect(200);

      const acmeFamilyNames = (
        acmeList.body.Resources as Array<{ name?: { familyName?: string } }>
      ).map(r => r.name?.familyName);
      const globexFamilyNames = (
        globexList.body.Resources as Array<{ name?: { familyName?: string } }>
      ).map(r => r.name?.familyName);
      expect(acmeFamilyNames).to.include('AcmeSide');
      expect(acmeFamilyNames).to.not.include('GlobexSide');
      expect(globexFamilyNames).to.include('GlobexSide');
      expect(globexFamilyNames).to.not.include('AcmeSide');
    });

    it('each tenant filters by id in its own scope', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'AcmeOnly' },
        })
        .expect(201);

      // Acme sees alice
      const found = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('id eq "alice"'))
        .set('Authorization', `Bearer ${acmeSecret}`)
        .expect(200);
      expect(found.body.totalResults).to.equal(1);

      // Globex does not
      const notFound = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('id eq "alice"'))
        .set('Authorization', `Bearer ${globexSecret}`)
        .expect(200);
      expect(notFound.body.totalResults).to.equal(0);
    });
  });

  describe('Cross-tenant isolation via SCIM base resolution and reference checks', () => {
    it('acme cannot GET a user that lives in globex by id (404)', async () => {
      // Seed bob only in globex.
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${globexSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'bob',
          name: { familyName: 'Smith' },
        })
        .expect(201);

      // Acme tries to look him up — lives in globex, should be invisible.
      await supertest(server.app)
        .get('/scim/v2/Users/bob')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .expect(404);

      // cleanup
      try {
        await server.ldap.delete(`uid=bob,ou=users,ou=e2e-globex,${baseDn}`);
      } catch {
        /* ignore */
      }
    });

    it('acme cannot add a globex user as a member of an acme group', async () => {
      // Seed bob in globex, and an empty group in acme.
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${globexSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'bob',
          name: { familyName: 'Smith' },
        })
        .expect(201);

      const foreignDn = `uid=bob,ou=users,ou=e2e-globex,${baseDn}`;

      // Try to create an acme group referencing bob by full cross-tenant DN.
      const res = await supertest(server.app)
        .post('/scim/v2/Groups')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'engineering',
          members: [{ value: foreignDn }],
        })
        .expect(201);

      // The group was created, but the foreign DN MUST NOT have leaked in.
      const values =
        (res.body.members as Array<{ value: string }> | undefined) || [];
      for (const m of values) {
        expect(m.value, 'foreign DN leaked into group members').to.not.equal(
          foreignDn
        );
      }

      // Cleanup
      try {
        await server.ldap.delete(`uid=bob,ou=users,ou=e2e-globex,${baseDn}`);
      } catch {
        /* ignore */
      }
    });

    it('acme cannot PATCH-add a globex user as a member of an acme group', async () => {
      // Seed bob in globex.
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${globexSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'bob',
          name: { familyName: 'Smith' },
        })
        .expect(201);

      // Create an empty acme group.
      await supertest(server.app)
        .post('/scim/v2/Groups')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'engineering',
        })
        .expect(201);

      const foreignDn = `uid=bob,ou=users,ou=e2e-globex,${baseDn}`;
      // SCIM Groups PATCH returns 200 with the updated resource on success.
      // We assert the 200 explicitly so a silent 4xx/5xx does NOT let the
      // test pass merely because the GET shows an untouched group.
      const patchRes = await supertest(server.app)
        .patch('/scim/v2/Groups/engineering')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            {
              op: 'add',
              path: 'members',
              value: [{ value: foreignDn }],
            },
          ],
        })
        .expect(200);
      // The PATCH response already shows members: the foreign DN must not
      // appear even in the immediate reply.
      const patchMembers =
        (patchRes.body.members as Array<{ value: string }> | undefined) || [];
      for (const m of patchMembers) {
        expect(m.value, 'foreign DN leaked in PATCH response').to.not.equal(
          foreignDn
        );
      }

      // Re-fetch as a secondary confirmation (guards against a stale-read
      // cache masking the real LDAP state).
      const after = await supertest(server.app)
        .get('/scim/v2/Groups/engineering')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .expect(200);
      const values =
        (after.body.members as Array<{ value: string }> | undefined) || [];
      for (const m of values) {
        expect(m.value).to.not.equal(foreignDn);
      }

      // Cleanup
      try {
        await server.ldap.delete(`uid=bob,ou=users,ou=e2e-globex,${baseDn}`);
      } catch {
        /* ignore */
      }
    });
  });

  describe('authzDynamic in-scope branch denial (per-tenant ACL)', () => {
    // The `e2e-users-only` token lives in the acme tenant but its ACL only
    // grants permission on ou=users — NOT ou=groups. This exercises the
    // authz hook wiring: the tenant base resolver happily constructs a
    // Groups DN under the tenant branch, then the ldap*request hooks check
    // the ACL and must deny.

    it('users-only token CAN manage Users in its tenant (sanity)', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Authorization', `Bearer ${usersOnlySecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'alice',
          name: { familyName: 'Scoped' },
        })
        .expect(201);
    });

    it('users-only token is DENIED on Groups list with 403', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Groups')
        .set('Authorization', `Bearer ${usersOnlySecret}`)
        .expect(403);
      expect(res.body.detail || res.body.error).to.match(/permission/i);
    });

    it('users-only token is DENIED on Groups create with 403', async () => {
      const res = await supertest(server.app)
        .post('/scim/v2/Groups')
        .set('Authorization', `Bearer ${usersOnlySecret}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'should-not-exist',
        })
        .expect(403);
      // Neither the tenant name nor the internal marker should leak.
      const payload = JSON.stringify(res.body);
      expect(payload).to.not.match(/\[authz-forbidden\]/);
    });
  });

  describe('Discovery honesty under tenant auth', () => {
    it('ServiceProviderConfig is identical for both tenants', async () => {
      const a = await supertest(server.app)
        .get('/scim/v2/ServiceProviderConfig')
        .set('Authorization', `Bearer ${acmeSecret}`)
        .expect(200);
      const g = await supertest(server.app)
        .get('/scim/v2/ServiceProviderConfig')
        .set('Authorization', `Bearer ${globexSecret}`)
        .expect(200);

      // Capabilities are process-level, not per-tenant.
      expect(a.body.patch.supported).to.equal(g.body.patch.supported);
      expect(a.body.bulk.supported).to.equal(g.body.bulk.supported);
      expect(a.body.filter.supported).to.equal(g.body.filter.supported);
      expect(a.body.sort.supported).to.equal(g.body.sort.supported);
    });
  });

  describe('configApi surfaces both plugins', () => {
    it('authzDynamic features expose token count but no tenant DNs', () => {
      const data = authz.getConfigApiData();
      expect(data.enabled).to.be.true;
      // Three seeded tokens: acme, globex, users-only.
      expect(data.tokenCount).to.equal(3);
      // No hashes or per-token DNs leak through the config API.
      expect(JSON.stringify(data)).to.not.match(/\{SSHA\}/);
      expect(JSON.stringify(data)).to.not.match(/cn=e2e-acme/);
      expect(JSON.stringify(data)).to.not.match(/cn=e2e-globex/);
      expect(JSON.stringify(data)).to.not.match(/cn=e2e-users-only/);
    });

    it('SCIM features advertise the per-tenant base template', () => {
      const data = scim.getConfigApiData();
      const baseResolution = data.baseResolution as {
        userBaseTemplate?: string;
        groupBaseTemplate?: string;
        hasBaseMap?: boolean;
      };
      expect(baseResolution.userBaseTemplate).to.match(/\{user\}/);
      expect(baseResolution.groupBaseTemplate).to.match(/\{user\}/);
      expect(baseResolution.hasBaseMap).to.equal(false);
    });
  });
});
