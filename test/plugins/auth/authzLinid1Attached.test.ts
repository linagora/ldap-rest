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
  const ADMIN_A = 'l1attach.admin.a';
  const NOBODY = 'l1attach.nobody';
  const IN_A = 'l1attach.user.a';
  const IN_B = 'l1attach.user.b';
  const LOOSE = 'l1attach.user.loose';
  const GROUP_A = 'l1attach-group-a';
  const GROUP_B = 'l1attach-group-b';
  const GROUP_LOOSE = 'l1attach-group-loose';
  const accounts = [ADMIN_A, NOBODY, IN_A, IN_B, LOOSE];
  const groups = [GROUP_A, GROUP_B, GROUP_LOOSE];
  let previousFilter: string | undefined;
  let previousSchema: string | undefined;

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

    // The point: the option is not set.
    previousFilter = process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    previousSchema = process.env.DM_LDAP_FLAT_SCHEMA;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';

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
    ] as [string, string | null][]) {
      await server.ldap
        .delete(`uid=${uid},${userBranch}`)
        .catch(() => undefined);
      await server.ldap.add(`uid=${uid},${userBranch}`, account(uid, org));
    }

    for (const [dn, ou, admin] of [
      [orgA, 'L1AttachOrgA', `uid=${ADMIN_A},${userBranch}`],
      [orgB, 'L1AttachOrgB', null],
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
    for (const dn of [orgA, orgB])
      await server.ldap.delete(dn).catch(() => undefined);
    if (previousFilter === undefined)
      delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    else process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES = previousFilter;
    if (previousSchema === undefined) delete process.env.DM_LDAP_FLAT_SCHEMA;
    else process.env.DM_LDAP_FLAT_SCHEMA = previousSchema;
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
});
