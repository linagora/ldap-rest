/**
 * Two ways a local administrator acted outside their branch (#325).
 *
 * The `/members` routes of the groups plugin wrote without the request, so
 * no authorization plugin saw them: anyone signed in could join any group,
 * a team mailbox included, or empty any list. The members themselves were
 * looked up the same way, so an account of another branch was accepted.
 *
 * And an organization's mail domains are those it links plus those of every
 * organization above it, while creating one only asks for write on its
 * parent: an administrator could create a sub-organization of their branch
 * linked to another customer's domain, then addresses in it.
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
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import LdapGroups from '../../../src/plugins/ldap/groups';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

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

describe('Delegated administration bypasses (#325)', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let groupsPlugin: LdapGroups;
  let base: string;
  let userBranch: string;
  let groupBranch: string;
  let top: string;
  let orgA: string;
  let orgB: string;
  let domA: string;
  let domB: string;
  let domC: string;
  const ROOT = 'deleg325.root';
  const ADMIN_A = 'deleg325.admin.a';
  const IN_A = 'deleg325.user.a';
  const IN_A2 = 'deleg325.user.a2';
  const IN_B = 'deleg325.user.b';
  const GROUP_A = 'deleg325-group-a';
  const GROUP_B = 'deleg325-group-b';
  const accounts = [ROOT, ADMIN_A, IN_A, IN_A2, IN_B];
  const groups = [GROUP_A, GROUP_B];
  const saved: Record<string, string | undefined> = {};
  // Created for the suite, in creation order; a nomenclature the directory
  // already holds is not ours to remove.
  const createdForDomains: string[] = [];

  const as = (uid: string) => ({
    'X-Test-User': uid,
    Accept: 'application/json',
  });
  const userDn = (uid: string) => `uid=${uid},${userBranch}`;
  const groupDn = (cn: string) => `cn=${cn},${groupBranch}`;

  const read = async (dn: string, attr: string): Promise<string[] | null> => {
    try {
      const res = (await server.ldap.search(
        { paged: false, scope: 'base', attributes: [attr] },
        dn
      )) as SearchResult;
      const entry = res.searchEntries[0];
      if (!entry) return null;
      const value = entry[attr];
      if (value === undefined) return [];
      return (Array.isArray(value) ? value : [value]).map(String);
    } catch {
      return null;
    }
  };

  const removeTree = async (dn: string): Promise<void> => {
    try {
      const res = (await server.ldap.search(
        { paged: false, scope: 'one', attributes: ['dn'] },
        dn
      )) as SearchResult;
      for (const entry of res.searchEntries) await removeTree(entry.dn);
    } catch {
      return;
    }
    await server.ldap.delete(dn).catch(() => undefined);
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    // A top organization of the suite's own, so that its administrator is
    // the one this test names rather than a change to the shared fixture.
    top = `ou=Deleg325Top,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    orgA = `ou=Deleg325A,${top}`;
    orgB = `ou=Deleg325B,${top}`;
    domA = `dc=deleg-a,ou=domains,ou=nomenclature,${base}`;
    domB = `dc=deleg-b,ou=domains,ou=nomenclature,${base}`;
    domC = `dc=deleg-c,ou=domains,ou=nomenclature,${base}`;

    for (const name of [
      'DM_LDAP_TOP_ORGANIZATION',
      'DM_LDAP_FLAT_SCHEMA',
      'DM_ORGANIZATION_SCHEMA',
    ])
      saved[name] = process.env[name];
    process.env.DM_LDAP_TOP_ORGANIZATION = top;
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    process.env.DM_ORGANIZATION_SCHEMA =
      './static/schemas/twake/organizations.json';

    server = new DM();
    await server.ready;

    for (const [dn, attrs] of [
      [
        `ou=nomenclature,${base}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'nomenclature' },
      ],
      [
        `ou=domains,ou=nomenclature,${base}`,
        { objectClass: ['top', 'organizationalUnit'], ou: 'domains' },
      ],
      ...[
        [domA, 'deleg-a'],
        [domB, 'deleg-b'],
        [domC, 'deleg-c'],
      ].map(([dn, dc]) => [
        dn,
        {
          objectClass: ['top', 'domain', 'domainRelatedObject'],
          dc,
          associatedDomain: `${dc}.example.org`,
        },
      ]),
    ] as [string, AttributesList][]) {
      try {
        await server.ldap.add(dn, attrs);
        createdForDomains.push(dn);
      } catch {
        // already there
      }
    }

    await removeTree(top);
    await server.ldap.add(top, {
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou: 'Deleg325Top',
      twakeDepartmentPath: 'Deleg325Top',
      twakeLocalAdminLink: `uid=${ROOT},ou=users,${base}`,
    });
    for (const [dn, ou, domain, admin] of [
      [orgA, 'Deleg325A', domA, `uid=${ADMIN_A},ou=users,${base}`],
      [orgB, 'Deleg325B', domB, null],
    ] as [string, string, string, string | null][]) {
      await server.ldap.add(dn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou,
        twakeDepartmentPath: `Deleg325Top / ${ou}`,
        twakeDomainLink: domain,
        ...(admin ? { twakeLocalAdminLink: admin } : {}),
      });
    }

    const account = (uid: string, org: string): AttributesList => ({
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid,
      cn: uid,
      sn: 'Deleg',
      givenName: 'Test',
      displayName: 'Test Deleg',
      mail: `${uid}@example.com`,
      twakeDepartmentLink: org,
      twakeDepartmentPath: 'Deleg325',
    });
    for (const [uid, org] of [
      [ROOT, top],
      [ADMIN_A, orgA],
      [IN_A, orgA],
      [IN_A2, orgA],
      [IN_B, orgB],
    ]) {
      await server.ldap.delete(userDn(uid)).catch(() => undefined);
      await server.ldap.add(userDn(uid), account(uid, org));
    }

    groupsPlugin = new LdapGroups(server);
    groupBranch = groupsPlugin.base as string;

    for (const [cn, org, member] of [
      [GROUP_A, orgA, IN_A],
      [GROUP_B, orgB, IN_B],
    ]) {
      await server.ldap.delete(groupDn(cn)).catch(() => undefined);
      await server.ldap.add(groupDn(cn), {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn,
        member: userDn(member),
        twakeDepartmentLink: org,
        twakeDepartmentPath: 'Deleg325',
      });
    }

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    await server.registerPlugin('ldapGroups', groupsPlugin);
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
    // The organization plugin reads its schema asynchronously, and the
    // domain link attribute is found through it.
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  after(async function () {
    this.timeout(20000);
    if (!server) return;
    for (const cn of groups)
      await server.ldap.delete(groupDn(cn)).catch(() => undefined);
    for (const uid of accounts)
      await server.ldap.delete(userDn(uid)).catch(() => undefined);
    await removeTree(top);
    for (const dn of [...createdForDomains].reverse())
      await server.ldap.delete(dn).catch(() => undefined);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('group membership', () => {
    const members = (cn: string) => read(groupDn(cn), 'member');

    it('lets an administrator add a member of their branch to their group', async () => {
      const res = await request
        .post(`/api/v1/ldap/groups/${GROUP_A}/members`)
        .set(as(ADMIN_A))
        .send({ member: [userDn(IN_A2)] });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await members(GROUP_A)).to.include(userDn(IN_A2));
    });

    it('lets them remove it again', async () => {
      const res = await request
        .delete(
          `/api/v1/ldap/groups/${GROUP_A}/members/${encodeURIComponent(userDn(IN_A2))}`
        )
        .set(as(ADMIN_A));
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await members(GROUP_A)).not.to.include(userDn(IN_A2));
    });

    it('refuses adding a member to a group of another branch', async () => {
      const res = await request
        .post(`/api/v1/ldap/groups/${GROUP_B}/members`)
        .set(as(ADMIN_A))
        .send({ member: [userDn(IN_A2)] });
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await members(GROUP_B)).not.to.include(userDn(IN_A2));
    });

    it('refuses removing a member from a group of another branch', async () => {
      const res = await request
        .delete(
          `/api/v1/ldap/groups/${GROUP_B}/members/${encodeURIComponent(userDn(IN_B))}`
        )
        .set(as(ADMIN_A));
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await members(GROUP_B)).to.include(userDn(IN_B));
    });

    it('refuses a member the caller cannot see, as one that does not exist', async () => {
      const res = await request
        .post(`/api/v1/ldap/groups/${GROUP_A}/members`)
        .set(as(ADMIN_A))
        .send({ member: [userDn(IN_B)] });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(JSON.stringify(res.body)).to.match(/not found/);
      expect(await members(GROUP_A)).not.to.include(userDn(IN_B));
    });

    it('refuses such a member at group creation too', async () => {
      const req = { user: ADMIN_A } as DmRequest;
      let error: unknown;
      try {
        await groupsPlugin.addGroup(
          'deleg325-group-new',
          [userDn(IN_B)],
          { twakeDepartmentLink: orgA, twakeDepartmentPath: 'Deleg325' },
          req
        );
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.match(/not found/);
      expect(await read(groupDn('deleg325-group-new'), 'cn')).to.equal(null);
    });
  });

  describe('mail domains of an organization', () => {
    const subOrg = () => `ou=Deleg325Sub,${orgA}`;
    const createSub = (uid: string, domains: string[]) =>
      request.post('/api/v1/ldap/organizations').set(as(uid)).send({
        ou: 'Deleg325Sub',
        parentDn: orgA,
        twakeDomainLink: domains,
      });
    const relink = (uid: string, domains: string[]) =>
      request
        .put(`/api/v1/ldap/organizations/${encodeURIComponent(subOrg())}`)
        .set(as(uid))
        .send({ replace: { twakeDomainLink: domains } });

    afterEach(async () => {
      await removeTree(subOrg());
    });

    it('refuses linking a sub-organization to a domain its branch was not given', async () => {
      const res = await createSub(ADMIN_A, [domB]);
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await read(subOrg(), 'ou')).to.equal(null);
    });

    it('accepts a domain an organization above already links', async () => {
      const res = await createSub(ADMIN_A, [domA]);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await read(subOrg(), 'twakeDomainLink')).to.deep.equal([domA]);
    });

    it('refuses adding such a domain to an existing sub-organization', async () => {
      expect((await createSub(ADMIN_A, [domA])).status).to.equal(200);
      const res = await relink(ADMIN_A, [domA, domB]);
      expect(res.status, JSON.stringify(res.body)).to.equal(403);
      expect(await read(subOrg(), 'twakeDomainLink')).to.deep.equal([domA]);
    });

    it('lets the administrator of the top organization link any domain', async () => {
      const res = await createSub(ROOT, [domC]);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await read(subOrg(), 'twakeDomainLink')).to.deep.equal([domC]);
    });

    it('lets a delegated administrator keep a domain they were given', async () => {
      expect((await createSub(ROOT, [domC])).status).to.equal(200);
      const res = await relink(ADMIN_A, [domC, domA]);
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(await read(subOrg(), 'twakeDomainLink')).to.have.members([
        domC,
        domA,
      ]);
    });
  });
});
