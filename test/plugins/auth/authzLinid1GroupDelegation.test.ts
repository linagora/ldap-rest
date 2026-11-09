/**
 * A group may delegate membership management to the administrators of other
 * organizations: each of them reads the group, sees only the members attached
 * to the organizations it writes, and adds or removes those, while the group's
 * own administrators keep the whole group and every other attribute.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';
import AuthBase, { type DmRequest } from '@ldap-rest/core/lib/auth/base';
import { isAuthzRefusal } from '@ldap-rest/core/lib/errors';
import AuthzLinid1 from '@ldap-rest/authz-linid1';
import AuthzScope from '@ldap-rest/authz-scope';
import LdapGroups from '@ldap-rest/ldap-groups';
import LdapOrganizations from '@ldap-rest/ldap-organizations';

import type { Role } from '../../../src/abstract/plugin';
import type { AttributesList } from '../../../src/lib/ldapActions';
import { DM } from '../../helpers/dm';
import { skipIfMissingEnvVars } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

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

describe('AuthzLinid1 group delegation', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let offRequest: ReturnType<typeof supertest>;
  let base: string;
  let userBranch: string;
  let groupBranch: string;
  let top: string;
  let sales: string;
  let engineering: string;
  let hr: string;
  let previousTop: string | undefined;
  let previousAttribute: string | undefined;
  let previousFilter: string | undefined;
  let previousGroupSchema: string | undefined;

  const ADMIN = 'l1del.admin';
  const SOPHIE = 'l1del.sophie';
  const ERIC = 'l1del.eric';
  const HR_ADMIN = 'l1del.hr.admin';
  const ALICE = 'l1del.alice';
  const BOB = 'l1del.bob';
  const CAROL = 'l1del.carol';
  const DAVE = 'l1del.dave';
  const NEW_SALES = 'l1del.new.sales';
  const HR_USER = 'l1del.hr.user';
  const GROUP = 'l1del-all-staff';
  const SOLO = 'l1del-solo';
  const accounts = [
    ADMIN,
    SOPHIE,
    ERIC,
    HR_ADMIN,
    ALICE,
    BOB,
    CAROL,
    DAVE,
    NEW_SALES,
    HR_USER,
  ];

  const as = (uid: string): Record<string, string> => ({
    'X-Test-User': uid,
    Accept: 'application/json',
  });
  const dnOf = (uid: string): string => `uid=${uid},${userBranch}`;
  const valuesOf = (
    body: Record<string, unknown>,
    attribute: string
  ): string[] => {
    const value = body[attribute];
    return (
      Array.isArray(value) ? value : value === undefined ? [] : [value]
    ).map(String);
  };
  const membersOf = (body: Record<string, unknown>): string[] =>
    valuesOf(body, 'member');

  before(function () {
    skipIfMissingEnvVars(this, [
      'DM_LDAP_DN',
      'DM_LDAP_PWD',
      'DM_LDAP_BASE',
      'DM_LDAP_TOP_ORGANIZATION',
    ]);
  });

  before(async function () {
    this.timeout(30000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    top = `ou=L1DelegTop,${base}`;
    sales = `ou=Sales,${top}`;
    engineering = `ou=Engineering,${top}`;
    hr = `ou=HR,${top}`;

    previousTop = process.env.DM_LDAP_TOP_ORGANIZATION;
    previousAttribute = process.env.DM_AUTHZ_GROUP_ADMIN_ATTRIBUTE;
    previousFilter = process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    previousGroupSchema = process.env.DM_GROUP_SCHEMA;
    // The point: the server judges attached entries whatever that option says
    delete process.env.DM_AUTHZ_FILTER_ATTACHED_ENTRIES;
    process.env.DM_LDAP_TOP_ORGANIZATION = top;
    process.env.DM_AUTHZ_GROUP_ADMIN_ATTRIBUTE = 'twakeGroupAdminOrgLink';
    // Another suite clears it without restoring
    process.env.DM_GROUP_SCHEMA = './static/schemas/twake/groups.json';

    server = new DM();
    await server.ready;
    const groupsPlugin = new LdapGroups(server);
    groupBranch = groupsPlugin.base as string;

    const organization = (
      dn: string,
      ou: string,
      admins: string[]
    ): AttributesList => ({
      objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
      ou,
      twakeDepartmentPath: `L1DelegTop / ${ou}`,
      ...(admins.length ? { twakeLocalAdminLink: admins } : {}),
    });
    for (const [dn, ou, admins] of [
      [top, 'L1DelegTop', [dnOf(ADMIN)]],
      [sales, 'Sales', [dnOf(SOPHIE)]],
      [engineering, 'Engineering', [dnOf(ERIC)]],
      [hr, 'HR', [dnOf(HR_ADMIN)]],
    ] as [string, string, string[]][]) {
      await server.ldap.delete(dn).catch(() => undefined);
      await server.ldap.add(dn, organization(dn, ou, admins));
    }

    const account = (uid: string, organizationDn: string): AttributesList => ({
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid,
      cn: uid,
      sn: 'Delegation',
      givenName: 'Test',
      displayName: 'Test Delegation',
      mail: `${uid}@example.com`,
      twakeDepartmentLink: organizationDn,
      twakeDepartmentPath: 'L1DelegTop',
    });
    for (const [uid, organizationDn] of [
      [ADMIN, top],
      [SOPHIE, sales],
      [ERIC, engineering],
      [HR_ADMIN, hr],
      [ALICE, sales],
      [BOB, sales],
      [CAROL, engineering],
      [DAVE, engineering],
      [NEW_SALES, sales],
      [HR_USER, hr],
    ] as [string, string][]) {
      await server.ldap.delete(dnOf(uid)).catch(() => undefined);
      await server.ldap.add(dnOf(uid), account(uid, organizationDn));
    }

    await server.ldap
      .delete(`cn=${GROUP},${groupBranch}`)
      .catch(() => undefined);
    await server.ldap.add(`cn=${GROUP},${groupBranch}`, {
      objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
      cn: GROUP,
      description: 'Everyone',
      twakeDepartmentLink: top,
      twakeDepartmentPath: 'L1DelegTop',
      twakeGroupAdminOrgLink: [sales, engineering],
      member: [dnOf(ALICE), dnOf(BOB), dnOf(CAROL), dnOf(DAVE)],
      owner: [dnOf(ALICE), dnOf(CAROL)],
    });
    await server.ldap
      .delete(`cn=${SOLO},${groupBranch}`)
      .catch(() => undefined);
    await server.ldap.add(`cn=${SOLO},${groupBranch}`, {
      objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
      cn: SOLO,
      twakeDepartmentLink: top,
      twakeDepartmentPath: 'L1DelegTop',
      twakeGroupAdminOrgLink: [sales],
      member: dnOf(ALICE),
    });

    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    await server.registerPlugin('ldapGroups', groupsPlugin);
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    const scope = new AuthzScope(server);
    await server.registerPlugin('authzScope', scope);
    await waitFor(() => Boolean(groupsPlugin.schema), {
      what: 'the group schema',
    });
    scope.afterLoad();
    server.setupErrorMiddleware();
    request = supertest(server.app);

    // The same directory, judged without the option: the delegation is inert
    delete process.env.DM_AUTHZ_GROUP_ADMIN_ATTRIBUTE;
    const offServer = new DM();
    await offServer.ready;
    await offServer.registerPlugin('testAuth', new TestAuthPlugin(offServer));
    await offServer.registerPlugin('authzLinid1', new AuthzLinid1(offServer));
    await offServer.registerPlugin('ldapGroups', new LdapGroups(offServer));
    await offServer.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(offServer)
    );
    const offScope = new AuthzScope(offServer);
    await offServer.registerPlugin('authzScope', offScope);
    offScope.afterLoad();
    offServer.setupErrorMiddleware();
    offRequest = supertest(offServer.app);
    process.env.DM_AUTHZ_GROUP_ADMIN_ATTRIBUTE = 'twakeGroupAdminOrgLink';
  });

  after(async () => {
    for (const cn of [GROUP, SOLO])
      await server.ldap
        .delete(`cn=${cn},${groupBranch}`)
        .catch(() => undefined);
    for (const uid of accounts)
      await server.ldap.delete(dnOf(uid)).catch(() => undefined);
    for (const dn of [hr, engineering, sales, top])
      await server.ldap.delete(dn).catch(() => undefined);
    const restore = (name: string, previous: string | undefined): void => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    };
    restore('DM_LDAP_TOP_ORGANIZATION', previousTop);
    restore('DM_AUTHZ_GROUP_ADMIN_ATTRIBUTE', previousAttribute);
    restore('DM_AUTHZ_FILTER_ATTACHED_ENTRIES', previousFilter);
    restore('DM_GROUP_SCHEMA', previousGroupSchema);
  });

  describe('reading the delegated group', () => {
    it('lists it to each delegated administrator, with their own members', async () => {
      const salesList = await request
        .get('/api/v1/ldap/groups')
        .set(as(SOPHIE));
      expect(salesList.status).to.equal(200);
      expect(salesList.body).to.have.property(GROUP);
      expect(membersOf(salesList.body[GROUP])).to.have.members([
        dnOf(ALICE),
        dnOf(BOB),
      ]);

      const engineeringList = await request
        .get('/api/v1/ldap/groups')
        .set(as(ERIC));
      expect(engineeringList.status).to.equal(200);
      expect(engineeringList.body).to.have.property(GROUP);
      expect(membersOf(engineeringList.body[GROUP])).to.have.members([
        dnOf(CAROL),
        dnOf(DAVE),
      ]);
    });

    it('reads it directly, with only the members of the caller', async () => {
      const res = await request
        .get(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(SOPHIE));
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(membersOf(res.body)).to.have.members([dnOf(ALICE), dnOf(BOB)]);
      expect(membersOf(res.body)).not.to.include(dnOf(CAROL));
      expect(valuesOf(res.body, 'owner')).to.deep.equal([dnOf(ALICE)]);
    });

    it('does not reveal another organization member through a filter', async () => {
      const hidden = await request
        .get('/api/v1/ldap/groups')
        .query({ match: `(member=${dnOf(CAROL)})` })
        .set(as(SOPHIE));
      expect(hidden.status).to.equal(200);
      expect(hidden.body).not.to.have.property(GROUP);

      const own = await request
        .get('/api/v1/ldap/groups')
        .query({ match: `(member=${dnOf(ALICE)})` })
        .set(as(SOPHIE));
      expect(own.status).to.equal(200);
      expect(own.body).not.to.have.property(GROUP);
    });

    it('does not reveal a member through the distinguishedName supertype', async () => {
      const hidden = await request
        .get('/api/v1/ldap/groups')
        .query({ match: `(distinguishedName=${dnOf(CAROL)})` })
        .set(as(SOPHIE));
      expect(hidden.status).to.equal(200);
      expect(hidden.body).not.to.have.property(GROUP);

      const own = await request
        .get('/api/v1/ldap/groups')
        .query({ match: `(distinguishedName=${dnOf(ALICE)})` })
        .set(as(SOPHIE));
      expect(own.status).to.equal(200);
      expect(own.body).not.to.have.property(GROUP);
    });

    it('does not answer a substring test on a hidden member', async () => {
      const hidden = await request
        .get('/api/v1/ldap/groups')
        .query({
          match: `(|(member=*alice*)(member=${dnOf(CAROL)}))`,
        })
        .set(as(SOPHIE));
      expect(hidden.status).to.equal(200);
      expect(hidden.body).not.to.have.property(GROUP);
    });

    it('does not return the group for a member filter', async () => {
      const res = await request
        .get('/api/v1/ldap/groups')
        .query({ match: `(member=${dnOf(ALICE)})` })
        .set(as(SOPHIE));
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body).not.to.have.property(GROUP);
    });

    it('does not hide the group for an extensible match on another attribute', async () => {
      const result = (await server.ldap.search(
        {
          paged: false,
          scope: 'sub',
          filter: `(cn:caseIgnoreMatch:=${GROUP})`,
          attributes: ['cn'],
        },
        groupBranch,
        { user: SOPHIE } as unknown as DmRequest
      )) as { searchEntries: { dn: string }[] };
      expect(result.searchEntries.map(entry => String(entry.dn))).to.include(
        `cn=${GROUP},${groupBranch}`
      );
    });

    it('does not let an unsupported test on another attribute restore the group', async () => {
      const result = (await server.ldap.search(
        {
          paged: false,
          scope: 'sub',
          filter: `(|(member=${dnOf(CAROL)})(!(cn:caseIgnoreMatch:=${GROUP})))`,
          attributes: ['cn'],
        },
        groupBranch,
        { user: SOPHIE } as unknown as DmRequest
      )) as { searchEntries: { dn: string }[] };
      expect(
        result.searchEntries.map(entry => String(entry.dn))
      ).not.to.include(`cn=${GROUP},${groupBranch}`);
    });

    it('does not let an extensible match without an attribute restore the group', async () => {
      const result = (await server.ldap.search(
        {
          paged: false,
          scope: 'sub',
          filter: `(:distinguishedNameMatch:=${dnOf(CAROL)})`,
          attributes: ['cn'],
        },
        groupBranch,
        { user: SOPHIE } as unknown as DmRequest
      )) as { searchEntries: { dn: string }[] };
      expect(
        result.searchEntries.map(entry => String(entry.dn))
      ).not.to.include(`cn=${GROUP},${groupBranch}`);
    });

    it('does not return the attributes the filter only widened for', async () => {
      const res = await request
        .get('/api/v1/ldap/groups')
        .query({ attributes: 'cn,member' })
        .set(as(SOPHIE));
      expect(res.status).to.equal(200);
      expect(res.body[GROUP]).to.have.property('cn', GROUP);
      expect(res.body[GROUP]).not.to.have.property('twakeDepartmentLink');
      expect(res.body[GROUP]).not.to.have.property('objectClass');
      expect(res.body[GROUP]).not.to.have.property('twakeGroupAdminOrgLink');
    });

    it('keeps the whole group visible to its own administrators', async () => {
      const res = await request
        .get(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(ADMIN));
      expect(res.status).to.equal(200);
      expect(membersOf(res.body)).to.have.members([
        dnOf(ALICE),
        dnOf(BOB),
        dnOf(CAROL),
        dnOf(DAVE),
      ]);
      expect(valuesOf(res.body, 'owner')).to.have.members([
        dnOf(ALICE),
        dnOf(CAROL),
      ]);
    });

    it('does not show the group to an administrator outside the delegation', async () => {
      const res = await request
        .get(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(HR_ADMIN));
      expect(res.status).to.equal(404);
    });
  });

  describe('managing members', () => {
    it('adds a member of the caller organization', async () => {
      const res = await request
        .post(`/api/v1/ldap/groups/${GROUP}/members`)
        .set(as(SOPHIE))
        .send({ member: dnOf(NEW_SALES) });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);

      const group = await request
        .get(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(SOPHIE));
      expect(membersOf(group.body)).to.include(dnOf(NEW_SALES));
    });

    it('removes a member of the caller organization', async () => {
      const res = await request
        .delete(
          `/api/v1/ldap/groups/${GROUP}/members/${encodeURIComponent(dnOf(NEW_SALES))}`
        )
        .set(as(SOPHIE));
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('leaves the last member to the group plugin placeholder', async () => {
      const res = await request
        .delete(
          `/api/v1/ldap/groups/${SOLO}/members/${encodeURIComponent(dnOf(ALICE))}`
        )
        .set(as(SOPHIE));
      expect(res.status, JSON.stringify(res.body)).to.equal(200);

      const group = await request
        .get(`/api/v1/ldap/groups/${SOLO}`)
        .set(as(SOPHIE));
      expect(group.status).to.equal(200);
      expect(membersOf(group.body)).to.deep.equal([]);
    });

    it('does not add a user of another organization', async () => {
      const res = await request
        .post(`/api/v1/ldap/groups/${GROUP}/members`)
        .set(as(SOPHIE))
        .send({ member: dnOf(HR_USER) });
      expect(res.status).to.equal(403);
    });

    it('does not remove a member of another organization', async () => {
      const res = await request
        .delete(
          `/api/v1/ldap/groups/${GROUP}/members/${encodeURIComponent(dnOf(CAROL))}`
        )
        .set(as(SOPHIE));
      expect(res.status).to.equal(403);
    });

    it('refuses an empty member change', async () => {
      const res = await request
        .post(`/api/v1/ldap/groups/${GROUP}/members`)
        .set(as(SOPHIE))
        .send({ member: [] });
      expect(res.status).to.equal(403);
    });

    it('refuses deleting the whole member attribute', async () => {
      let refused = false;
      try {
        await server.ldap.authorize('ldapmodifyrequest', [
          `cn=${GROUP},${groupBranch}`,
          { delete: { member: [] } },
          0,
          { user: SOPHIE } as unknown as DmRequest,
        ]);
      } catch (err) {
        expect(isAuthzRefusal(err)).to.equal(true);
        refused = true;
      }
      expect(refused).to.equal(true);
    });

    it('does not change another attribute of the group', async () => {
      const description = await request
        .put(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(SOPHIE))
        .send({ replace: { description: 'Changed delegation' } });
      expect(description.status).to.equal(403);

      const delegation = await request
        .put(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(SOPHIE))
        .send({ replace: { twakeGroupAdminOrgLink: [hr] } });
      expect(delegation.status).to.equal(403);
    });

    it('does not rename, move or delete the group', async () => {
      const rename = await request
        .post(`/api/v1/ldap/groups/${GROUP}/rename`)
        .set(as(SOPHIE))
        .send({ newCn: 'l1del-renamed' });
      expect(rename.status).to.equal(403);

      const move = await request
        .post(`/api/v1/ldap/groups/${GROUP}/move`)
        .set(as(SOPHIE))
        .send({ targetOrgDn: hr });
      expect(move.status).to.equal(403);

      const deletion = await request
        .delete(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(SOPHIE));
      expect(deletion.status).to.equal(403);
    });

    it('lets the group administrator change its delegation', async () => {
      const res = await request
        .put(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(ADMIN))
        .send({ replace: { twakeGroupAdminOrgLink: [sales, engineering] } });
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
    });

    it('applies a delegation change at once', async () => {
      const changed = await request
        .put(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(ADMIN))
        .send({ replace: { twakeGroupAdminOrgLink: [sales] } });
      expect(changed.status, JSON.stringify(changed.body)).to.equal(200);

      const eric = await request
        .get(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(ERIC));
      expect(eric.status).to.equal(404);

      await request
        .put(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(ADMIN))
        .send({ replace: { twakeGroupAdminOrgLink: [sales, engineering] } });
    });
  });

  describe('scope', () => {
    it('lists the delegated group for each delegated administrator', async () => {
      for (const caller of [SOPHIE, ERIC]) {
        const res = await request.get('/api/v1/authz/scope').set(as(caller));
        expect(res.status, caller).to.equal(200);
        expect(res.body, caller)
          .to.have.property('delegatedGroups')
          .that.deep.includes({
            dn: `cn=${GROUP},${groupBranch}`,
            manageMembers: true,
          });
      }
    });

    it('omits the field for a caller the delegation does not reach', async () => {
      const res = await request.get('/api/v1/authz/scope').set(as(HR_ADMIN));
      expect(res.status).to.equal(200);
      expect(res.body).not.to.have.property('delegatedGroups');
    });
  });

  describe('without the option', () => {
    it('leaves the delegated group invisible to the other organizations', async () => {
      const res = await offRequest
        .get(`/api/v1/ldap/groups/${GROUP}`)
        .set(as(SOPHIE));
      expect(res.status).to.equal(404);
    });

    it('omits delegatedGroups from the scope', async () => {
      const res = await offRequest.get('/api/v1/authz/scope').set(as(SOPHIE));
      expect(res.status).to.equal(200);
      expect(res.body).not.to.have.property('delegatedGroups');
    });
  });
});
