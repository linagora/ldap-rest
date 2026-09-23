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
import type { AttributesList } from '../../../src/lib/ldapActions';
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

  it('should not serve one administrator the list filtered for another', async () => {
    // Back to back, on the same branch: the second answer may not come from
    // what the first one was allowed to see.
    const a = Object.keys(await list(ADMIN_A));
    const b = Object.keys(await list(ADMIN_B));
    expect(a).to.include(IN_A);
    expect(a).not.to.include(IN_B);
    expect(b).to.include(IN_B);
    expect(b).not.to.include(IN_A);
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
