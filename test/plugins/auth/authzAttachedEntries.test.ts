/**
 * An account is governed by the organization it is attached to, not by the
 * branch it is stored in.
 *
 * Every account of a directory lives in the same `ou=users`, so a branch
 * check on its parent says the same thing about all of them: either every
 * administrator reaches every account, or none does. Neither is what a local
 * administrator is. What tells them apart is `twakeDepartmentLink`, so that
 * is what read filtering and write checks go by.
 *
 * Entries attached to nothing — an organization, a nomenclature value — keep
 * being judged on their parent, and stay visible to any administrator: they
 * are the reference data every console reads.
 *
 * The last case is the one this change could plausibly break. Filtering runs
 * after the search cache, so what one caller may not see must never reach the
 * next from the cache. Two administrators listing the same branch in a row is
 * exactly the shape that would expose it.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;
  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string' && user) {
      req.user = user;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

describe('Authorization by attachment', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let orgA: string;
  let orgB: string;
  const ADMIN_A = 'attach.admin.a';
  const ADMIN_B = 'attach.admin.b';
  const IN_A = 'attach.user.a';
  const IN_B = 'attach.user.b';
  const LOOSE = 'attach.user.loose';
  let previousConfig: string | undefined;
  let previousTtl: string | undefined;
  let previousFilter: string | undefined;
  let previousCacheTtl: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgA = `ou=AttachOrgA,${base}`;
    orgB = `ou=AttachOrgB,${base}`;

    // The whole point of this file, and off by default: see
    // `authz_filter_attached_entries`.
    // The cache holds base-scope, unpaginated reads only, and is off by
    // default. Without it the case below cannot fail for the reason it names.
    previousCacheTtl = process.env.DM_LDAP_CACHE_TTL;
    process.env.DM_LDAP_CACHE_TTL = '60';
    previousFilter = process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES = 'true';
    previousConfig = process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    previousTtl = process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        [ADMIN_A]: { [orgA]: { read: true, write: true, delete: true } },
        [ADMIN_B]: { [orgB]: { read: true, write: true, delete: true } },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];

    for (const [dn, ou] of [
      [orgA, 'AttachOrgA'],
      [orgB, 'AttachOrgB'],
    ] as [string, string][])
      await server.ldap
        .add(dn, {
          objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
          ou,
          twakeDepartmentPath: ou,
        })
        .catch(() => undefined);

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);

    const account = (
      uid: string,
      org: string | null,
      num: string
    ): AttributesList => ({
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid,
      cn: uid,
      sn: 'Attach',
      givenName: 'Test',
      displayName: 'Test Attach',
      mail: `${uid}@example.com`,
      employeeNumber: num,
      ...(org
        ? { twakeDepartmentLink: org, twakeDepartmentPath: 'AttachOrg' }
        : {}),
      twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
      twakeDeliveryMode: [
        `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
      ],
    });

    for (const [uid, org, num] of [
      [IN_A, orgA, 'ATT00001'],
      [IN_B, orgB, 'ATT00002'],
      [LOOSE, null, 'ATT00003'],
    ] as [string, string | null, string][]) {
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
      await server.ldap.add(`uid=${uid},${userBranch}`, account(uid, org, num));
    }
  });

  after(async () => {
    for (const uid of [IN_A, IN_B, LOOSE])
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
    for (const dn of [orgA, orgB])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousConfig === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    else process.env.DM_AUTHZ_PER_BRANCH_CONFIG = previousConfig;
    if (previousTtl === undefined)
      delete process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL;
    else process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = previousTtl;
    if (previousFilter === undefined)
      delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    else process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES = previousFilter;
    if (previousCacheTtl === undefined) delete process.env.DM_LDAP_CACHE_TTL;
    else process.env.DM_LDAP_CACHE_TTL = previousCacheTtl;
  });

  const list = async (who: string): Promise<Record<string, unknown>> => {
    const res = await request
      .get('/api/v1/ldap/users')
      .set('X-Test-User', who)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    return res.body as Record<string, unknown>;
  };

  it('should show an administrator the accounts attached to their branch', async () => {
    const seen = await list(ADMIN_A);
    expect(Object.keys(seen)).to.include(IN_A);
  });

  it('should hide the accounts attached elsewhere', async () => {
    const seen = await list(ADMIN_A);
    expect(Object.keys(seen)).not.to.include(IN_B);
  });

  it('should leave an unattached entry visible to every administrator', async () => {
    for (const who of [ADMIN_A, ADMIN_B]) {
      const seen = await list(who);
      expect(Object.keys(seen), who).to.include(LOOSE);
    }
  });

  it('should not serve one administrator what another was allowed to see', async () => {
    // The listing is paginated and never cached, so it cannot exercise this.
    // A single-entry read is base-scope and unpaginated, which is exactly
    // what the cache holds: A reads an entry of their branch, B asks for the
    // same DN, and the answer must be B's own — not A's, served from the
    // cache. A reads it again afterwards, to show the cache was not emptied
    // on B's behalf either.
    const read = async (who: string): Promise<number> =>
      (
        await request
          .get(`/api/v1/ldap/users/${IN_A}`)
          .set('X-Test-User', who)
          .set('Accept', 'application/json')
      ).status;

    expect(await read(ADMIN_A), 'A reads their own').to.equal(200);
    expect(
      await read(ADMIN_B),
      'B must not get it from the cache'
    ).to.not.equal(200);
    expect(await read(ADMIN_A), 'A still reads their own').to.equal(200);
  });

  it('should show each administrator their own accounts in a listing', async () => {
    const a = Object.keys(await list(ADMIN_A));
    const b = Object.keys(await list(ADMIN_B));
    expect(a).to.include(IN_A);
    expect(a).not.to.include(IN_B);
    expect(b).to.include(IN_B);
    expect(b).not.to.include(IN_A);
  });

  it('should still filter when the caller asks for a narrow projection', async () => {
    // "Ask only for the fields you display" is the normal client shape, and
    // what SCIM does. An entry that came back without its organization link
    // is indistinguishable from one attached to nothing, so the filter would
    // pass everything: the feature would be off exactly where it is wanted.
    const res = await request
      .get('/api/v1/ldap/users?attributes=uid,cn,mail')
      .set('X-Test-User', ADMIN_A)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    const seen = res.body as Record<string, Record<string, unknown>>;
    expect(Object.keys(seen)).to.include(IN_A);
    expect(Object.keys(seen)).not.to.include(IN_B);
  });

  it('should not hand back the link attribute nobody asked for', async () => {
    const res = await request
      .get('/api/v1/ldap/users?attributes=uid,cn,mail')
      .set('X-Test-User', ADMIN_A)
      .set('Accept', 'application/json');
    const seen = res.body as Record<string, Record<string, unknown>>;
    expect(seen[IN_A]).to.not.have.property('twakeDepartmentLink');
  });

  it('should refuse to read one account attached to another branch', async () => {
    const res = await request
      .get(`/api/v1/ldap/users/${IN_B}`)
      .set('X-Test-User', ADMIN_A)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.not.equal(200);
  });

  it('should refuse a deletion of an account attached to another branch', async () => {
    const res = await request
      .delete(`/api/v1/ldap/users/${IN_B}`)
      .set('X-Test-User', ADMIN_A)
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    // The refusal has to be the entry still being there, not just the code.
    const still = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['dn'] },
      `uid=${IN_B},${userBranch}`
    )) as SearchResult;
    expect(still.searchEntries.length).to.equal(1);
  });

  it('should filter a search that asks for the DN alone', async () => {
    // What SCIM does. The entry comes back carrying no attribute at all, so
    // nothing on it says where it is attached: the link has to be added to
    // the projection or the filter has nothing to judge.
    const seen = (await server.ldap.search(
      {
        paged: false,
        scope: 'sub',
        filter: `(uid=${IN_B})`,
        attributes: ['dn'],
      },
      userBranch,
      { user: ADMIN_A } as unknown as Parameters<typeof server.ldap.search>[2]
    )) as SearchResult;
    expect(seen.searchEntries.length).to.equal(0);
  });

  it('should refuse a write on an account attached to another branch', async () => {
    const res = await request
      .put(`/api/v1/ldap/users/${IN_B}`)
      .set('X-Test-User', ADMIN_A)
      .type('json')
      .send({ replace: { description: 'reached across' } });
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('should allow a write on an account attached to their own', async () => {
    const res = await request
      .put(`/api/v1/ldap/users/${IN_A}`)
      .set('X-Test-User', ADMIN_A)
      .type('json')
      .send({ replace: { description: 'own branch' } });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
  });
});
