/**
 * authzLinid1 judges accounts and groups by the organization they are
 * attached to, whatever `--authz-filter-attached-entries` says.
 *
 * Its branches are organizations, and a Twake directory keeps every account
 * in one flat `ou=users` and every group in `ou=groups`: judged by their
 * parent, they belong to nobody's branch, and the administrator of the whole
 * tree could neither list nor change a single account.
 *
 * The group reads are the other half: they searched without the request, so
 * no authorization plugin saw them and any signed-in caller read every group
 * with its members.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import type { AttributesList } from '../../../src/lib/ldapActions';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import AuthzScope from '../../../src/plugins/auth/authzScope';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars } from '../../helpers/env';

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

describe('AuthzLinid1 by attachment', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let groupBranch: string;
  let orgA: string;
  let orgB: string;
  let transit: string;
  const ADMIN_A = 'l1attach.admin.a';
  const NOBODY = 'l1attach.nobody';
  const IN_A = 'l1attach.user.a';
  const IN_B = 'l1attach.user.b';
  const LOOSE = 'l1attach.user.loose';
  const T_LOOSE = 'l1attach.transit.loose';
  const T_LOOSE_B = 'l1attach.transit.loose.b';
  const T_PARKED = 'l1attach.transit.parked';
  const T_LEAVING = 'l1attach.transit.leaving';
  const T_HELD_B = 'l1attach.transit.held.b';
  const GROUP_A = 'l1attach-group-a';
  const GROUP_B = 'l1attach-group-b';
  const GROUP_LOOSE = 'l1attach-group-loose';
  const accounts = [
    ADMIN_A,
    NOBODY,
    IN_A,
    IN_B,
    LOOSE,
    T_LOOSE,
    T_LOOSE_B,
    T_PARKED,
    T_LEAVING,
    T_HELD_B,
  ];
  const groups = [GROUP_A, GROUP_B, GROUP_LOOSE];
  let previousFilter: string | undefined;
  let previousSchema: string | undefined;
  let previousTransit: string | undefined;

  const as = (uid: string) => ({
    'X-Test-User': uid,
    Accept: 'application/json',
  });

  before(function () {
    skipIfMissingEnvVars(this, [
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_BASE',
      'DM_LDAP_TOP_ORGANIZATION',
    ]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgA = `ou=L1AttachOrgA,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    orgB = `ou=L1AttachOrgB,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    transit = `ou=L1AttachTransit,${process.env.DM_LDAP_TOP_ORGANIZATION}`;

    // The point: the option is not set.
    previousFilter = process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    previousSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    previousTransit = process.env.DM_AUTHZ_TRANSIT_BRANCH;
    process.env.DM_AUTHZ_TRANSIT_BRANCH = transit;

    server = new DM();
    await server.ready;
    const groupsPlugin = new LdapGroups(server);
    groupBranch = groupsPlugin.base as string;

    const account = (uid: string, org: string | null): AttributesList => ({
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid,
      cn: uid,
      sn: 'Attach',
      givenName: 'Test',
      displayName: 'Test Attach',
      mail: `${uid}@example.com`,
      ...(org
        ? { twakeDepartmentLink: org, twakeDepartmentPath: 'L1AttachOrg' }
        : {}),
    });
    for (const [uid, org] of [
      [ADMIN_A, orgA],
      [NOBODY, orgB],
      [IN_A, orgA],
      [IN_B, orgB],
      [LOOSE, null],
      [T_LOOSE, null],
      [T_LOOSE_B, null],
      [T_PARKED, transit],
      [T_LEAVING, orgA],
      [T_HELD_B, orgB],
    ] as [string, string | null][]) {
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
      await server.ldap.add(`uid=${uid},${userBranch}`, account(uid, org));
    }

    for (const [dn, ou, admin] of [
      [orgA, 'L1AttachOrgA', `uid=${ADMIN_A},${userBranch}`],
      [orgB, 'L1AttachOrgB', null],
      [transit, 'L1AttachTransit', null],
    ] as [string, string, string | null][]) {
      await server.ldap.delete(dn).catch(() => undefined);
      await server.ldap.add(dn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou,
        twakeDepartmentPath: ou,
        ...(admin ? { twakeLocalAdminLink: admin } : {}),
      });
    }

    for (const [cn, org] of [
      [GROUP_A, orgA],
      [GROUP_B, orgB],
      [GROUP_LOOSE, null],
    ] as [string, string | null][]) {
      await server.ldap
        .delete(`cn=${cn},${groupBranch}`)
        .catch(() => undefined);
      await server.ldap.add(`cn=${cn},${groupBranch}`, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn,
        member: `uid=${IN_A},${userBranch}`,
        ...(org
          ? { twakeDepartmentLink: org, twakeDepartmentPath: 'L1AttachOrg' }
          : {}),
      });
    }

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', groupsPlugin);
    const scope = new AuthzScope(server);
    await server.registerPlugin('authzScope', scope);
    scope.afterLoad();
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const cn of groups)
      await server.ldap
        .delete(`cn=${cn},${groupBranch}`)
        .catch(() => undefined);
    for (const uid of accounts)
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
    for (const dn of [orgA, orgB, transit])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousFilter === undefined)
      delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    else process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES = previousFilter;
    if (previousSchema === undefined) delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousSchema;
    if (previousTransit === undefined)
      delete process.env.DM_AUTHZ_TRANSIT_BRANCH;
    else process.env.DM_AUTHZ_TRANSIT_BRANCH = previousTransit;
  });

  describe('accounts', () => {
    it('lists the accounts attached to the branch, and those attached to none', async () => {
      const res = await request.get('/api/v1/ldap/users').set(as(ADMIN_A));
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property(IN_A);
      expect(res.body).to.have.property(LOOSE);
      expect(res.body).not.to.have.property(IN_B);
    });

    it('changes an account attached to the branch', async () => {
      const res = await request
        .put(`/api/v1/ldap/users/${IN_A}`)
        .set(as(ADMIN_A))
        .send({ replace: { displayName: 'Changed by A' } });
      expect(res.status).to.equal(200);
    });

    it('does not read an account attached to another branch', async () => {
      const res = await request
        .get(`/api/v1/ldap/users/${IN_B}`)
        .set(as(ADMIN_A));
      expect(res.status).to.equal(404);
    });

    it('refuses to change an account attached to another branch', async () => {
      const res = await request
        .put(`/api/v1/ldap/users/${IN_B}`)
        .set(as(ADMIN_A))
        .send({ replace: { displayName: 'Changed by A' } });
      expect(res.status).to.equal(403);
    });

    it('refuses the listing to a caller administering no branch', async () => {
      const res = await request.get('/api/v1/ldap/users').set(as(NOBODY));
      expect(res.status).to.equal(403);
    });
  });

  describe('groups', () => {
    it('lists the groups attached to the branch, and those attached to none', async () => {
      const res = await request.get('/api/v1/ldap/groups').set(as(ADMIN_A));
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property(GROUP_A);
      expect(res.body).to.have.property(GROUP_LOOSE);
      expect(res.body).not.to.have.property(GROUP_B);
    });

    it('does not give the attachment to a caller that did not ask for it', async () => {
      const res = await request.get('/api/v1/ldap/groups').set(as(ADMIN_A));
      expect(res.body[GROUP_A]).not.to.have.property('twakeDepartmentLink');
    });

    it('reads a group attached to the branch', async () => {
      const res = await request
        .get(`/api/v1/ldap/groups/${GROUP_A}`)
        .set(as(ADMIN_A));
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('cn', GROUP_A);
    });

    it('does not read a group attached to another branch', async () => {
      const res = await request
        .get(`/api/v1/ldap/groups/${GROUP_B}`)
        .set(as(ADMIN_A));
      expect(res.status).to.equal(404);
    });

    it('refuses the group list and every group to a caller administering no branch', async () => {
      const list = await request.get('/api/v1/ldap/groups').set(as(NOBODY));
      expect(list.status).to.equal(403);
      for (const cn of [GROUP_A, GROUP_LOOSE]) {
        const one = await request
          .get(`/api/v1/ldap/groups/${cn}`)
          .set(as(NOBODY));
        expect(one.status, cn).to.equal(403);
      }
    });
  });

  describe('transit', () => {
    const move = (uid: string, targetOrgDn: string, caller: string) =>
      request
        .post(`/api/v1/ldap/users/${uid}/move`)
        .set(as(caller))
        .send({ targetOrgDn });

    it('names the transit branch in the scope', async () => {
      const res = await request.get('/api/v1/authz/scope').set(as(ADMIN_A));
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('transit', transit);
    });

    it('lists the accounts parked in transit', async () => {
      const res = await request.get('/api/v1/ldap/users').set(as(ADMIN_A));
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property(T_PARKED);
      expect(res.body).not.to.have.property(T_HELD_B);
    });

    it('claims an account attached to no organization', async () => {
      const res = await move(T_LOOSE, orgA, ADMIN_A);
      expect(res.status).to.equal(200);
    });

    it('claims an account parked in transit', async () => {
      const res = await move(T_PARKED, orgA, ADMIN_A);
      expect(res.status).to.equal(200);
    });

    it('does not claim an account into a branch the caller does not write', async () => {
      const res = await move(T_LOOSE_B, orgB, ADMIN_A);
      expect(res.status).to.equal(403);
    });

    it('puts an account of the branch in transit, which then leaves the branch', async () => {
      const res = await move(T_LEAVING, transit, ADMIN_A);
      expect(res.status).to.equal(200);
      const moved = await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['twakeDepartmentLink'] },
        `uid=${T_LEAVING},${userBranch}`
      );
      expect(
        String(
          (moved as { searchEntries: Record<string, unknown>[] })
            .searchEntries[0].twakeDepartmentLink
        )
      ).to.equal(transit);
    });

    it('does not put in transit an account of another branch', async () => {
      // Not even found: the caller does not see it.
      const res = await move(T_HELD_B, transit, ADMIN_A);
      expect(res.status).to.equal(404);
    });

    it('does not let an account in transit be changed before it is claimed', async () => {
      const res = await request
        .put(`/api/v1/ldap/users/${T_LOOSE_B}`)
        .set(as(ADMIN_A))
        .send({ replace: { displayName: 'Changed in transit' } });
      expect(res.status).to.equal(403);
    });

    it('does not let a caller administering no branch touch transit', async () => {
      const res = await move(T_LOOSE_B, transit, NOBODY);
      expect(res.status).to.equal(403);
    });
  });
});
