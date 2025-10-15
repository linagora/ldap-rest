import { expect } from 'chai';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import supertest from 'supertest';
import { SearchResult } from 'ldapts';

const { DM_LDAP_GROUP_BASE } = process.env;
process.env.DM_GROUP_SCHEMA = '';

describe('LdapGroups Plugin', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_GROUP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping ldapGroups tests: DM_GROUP_BASE and LDAP_LIB env vars are required'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let server: DM;
  let plugin: LdapGroups;

  const user1 = `uid=user1,${process.env.DM_LDAP_BASE}`;
  const user2 = `uid=user2,${process.env.DM_LDAP_BASE}`;

  before(async () => {
    server = new DM();
    plugin = new LdapGroups(server);
    const entry = {
      objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
      cn: 'Test User',
      sn: 'User',
      uid: 'testuser',
      mail: 'test@test.org',
    };
    await plugin.ldap.add(user1, entry);
    await plugin.ldap.add(user2, { ...entry, mail: 'test2@test.org' });
  });

  after(async () => {
    try {
      await plugin.ldap.delete(user1);
      await plugin.ldap.delete(user2);
    } catch (e) {
      // ignore
    }
  });

  afterEach(async () => {
    try {
      await plugin.deleteGroup('testgroup');
    } catch (e) {
      // ignore
    }
  });

  describe('constructor', () => {
    it('should set base from config', () => {
      expect(plugin.base).to.equal(DM_LDAP_GROUP_BASE);
    });
  });

  describe('New group', () => {
    it('should add/delete group with members', async () => {
      await plugin.addGroup('testgroup', [user1]);
      const listEntries = await plugin.listGroups();
      // @ts-ignore
      expect(listEntries).to.have.property('testgroup');
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user1],
        },
      });
      expect(await plugin.deleteGroup('testgroup')).to.be.true;
    });

    it('should add/delete group even if no members', async () => {
      await plugin.addGroup('testgroup');
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [],
        },
      });
      expect(await plugin.deleteGroup('testgroup')).to.be.true;
    });

    it('should add/modify/delete group with additional attributes', async () => {
      await plugin.addGroup('testgroup', [user1], {
        description: 'My test group',
      });
      expect(
        await plugin.searchGroupsByName('testgroup', false, [
          'cn',
          'description',
          'member',
        ])
      ).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user1],
          description: 'My test group',
        },
      });
      await plugin.modifyGroup('testgroup', {
        replace: { description: 'My modified test group' },
      });
      expect(
        await plugin.searchGroupsByName('testgroup', false, [
          'cn',
          'description',
          'member',
        ])
      ).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user1],
          description: 'My modified test group',
        },
      });
      expect(await plugin.deleteGroup('testgroup')).to.be.true;
    });
  });

  describe('Manipulate member', () => {
    this.afterEach(async () => {
      try {
        await plugin.deleteGroup('testgroupbis');
      } catch (e) {
        // ignore
      }
    });

    it('should add/delete member to group', async () => {
      await plugin.addGroup('testgroup');
      await plugin.addMember('testgroup', user2);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user2],
        },
      });
      await plugin.deleteMember('testgroup', user2);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [],
        },
      });
    });

    it('should not accept unexisting user as member', async () => {
      await plugin.addGroup('testgroup');
      try {
        await plugin.addMember(
          'testgroup',
          'uid=unexistinguser,' + process.env.DM_LDAP_BASE
        );
        expect.fail('Should not accept unexisting user as member');
      } catch (e) {
        expect((e as Error).message).to.match(/uid=unexistinguser.* not found/);
      }
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [],
        },
      });
    });

    it('should rename group', async () => {
      await plugin.addGroup('testgroup', [user1]);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user1],
        },
      });
      await plugin.renameGroup('testgroup', 'testgroupbis');
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({});
      expect(await plugin.searchGroupsByName('testgroupbis')).to.deep.equal({
        testgroupbis: {
          dn: `cn=testgroupbis,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroupbis',
          member: [user1],
        },
      });
    });
  });

  describe('API', () => {
    let request: any;
    before(async () => {
      plugin.api(server.app);
      request = supertest(server.app);
    });

    it('should add/del group via API', async () => {
      let res = await request
        .post('/api/v1/ldap/groups')
        .type('json')
        .send({
          cn: 'testgroup',
          member: [user1],
        });
      expect(res.body).to.deep.equal({ success: true });
      expect(res.status).to.equal(200);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user1],
        },
      });

      res = await request
        .delete('/api/v1/ldap/groups/testgroup')
        .type('json')
        .send();
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({});
    });

    it('should add/del member via API', async () => {
      await plugin.addGroup('testgroup');
      let res = await request
        .post('/api/v1/ldap/groups/testgroup/members')
        .type('json')
        .send({
          member: user2,
        });
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [user2],
        },
      });

      res = await request
        .delete(`/api/v1/ldap/groups/testgroup/members/${user2}`)
        .type('json')
        .send();
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [],
        },
      });
    });

    it('should list via API', async () => {
      let res = await request
        .post('/api/v1/ldap/groups')
        .type('json')
        .send({
          cn: 'testgroup',
          member: [user1],
        });
      expect(res.body).to.deep.equal({ success: true });
      expect(res.status).to.equal(200);
      res = await request
        .get('/api/v1/ldap/groups?match=cn=*estgrou*&attributes=cn,member')
        .set('Accept', 'application/json');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('testgroup');
      expect(res.body.testgroup).to.deep.equal({
        dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
        cn: 'testgroup',
        member: [user1],
      });
    });
  });

  describe('moveGroup', function () {
    // Skip tests if no organization plugin configured
    if (!process.env.DM_LDAP_TOP_ORGANIZATION) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping moveGroup tests: DM_LDAP_TOP_ORGANIZATION env var is required'
      );
      // @ts-ignore
      this.skip?.();
      return;
    }

    const org1Dn = `ou=testorg1,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const org2Dn = `ou=testorg2,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
    const groupDn = `cn=testgroup,${DM_LDAP_GROUP_BASE}`;

    beforeEach(async () => {
      // Create test organizations
      await plugin.ldap.add(org1Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'testorg1',
        twakeDepartmentPath: 'Test Org 1',
      });
      await plugin.ldap.add(org2Dn, {
        objectClass: ['organizationalUnit', 'twakeDepartment', 'top'],
        ou: 'testorg2',
        twakeDepartmentPath: 'Test Org 2',
      });

      // Create test group with department link
      await plugin.ldap.add(groupDn, {
        objectClass: ['groupOfNames', 'twakeStaticGroup', 'top'],
        cn: 'testgroup',
        member: [`cn=fakeuser`],
        twakeDepartmentLink: org1Dn,
        twakeDepartmentPath: 'Test Org 1',
      });
    });

    afterEach(async () => {
      try {
        await plugin.ldap.delete(groupDn);
      } catch (e) {
        // ignore
      }
      try {
        await plugin.ldap.delete(org1Dn);
      } catch (e) {
        // ignore
      }
      try {
        await plugin.ldap.delete(org2Dn);
      } catch (e) {
        // ignore
      }
    });

    it('should move group to different organization', async () => {
      const result = await plugin.moveGroup('testgroup', org2Dn);
      expect(result).to.have.property('success', true);

      // Verify group was moved
      const group = (await plugin.ldap.search(
        { paged: false, scope: 'base' },
        groupDn
      )) as SearchResult;
      expect(group.searchEntries[0].twakeDepartmentLink).to.equal(org2Dn);
      expect(group.searchEntries[0].twakeDepartmentPath).to.equal('Test Org 2');
    });

    it('should reject move to same location', async () => {
      try {
        await plugin.moveGroup('testgroup', org1Dn);
        expect.fail('Should have thrown error');
      } catch (e) {
        expect((e as Error).message).to.match(
          /already in the target organization/
        );
      }
    });

    it('should reject move of group without department link', async () => {
      // Create group without department link
      const noDeptGroupDn = `cn=nodeptgroup,${DM_LDAP_GROUP_BASE}`;
      await plugin.ldap.add(noDeptGroupDn, {
        objectClass: ['groupOfNames', 'top'],
        cn: 'nodeptgroup',
        member: [`cn=fakeuser`],
      });

      try {
        await plugin.moveGroup('nodeptgroup', org2Dn);
        expect.fail('Should have thrown error');
      } catch (e) {
        expect((e as Error).message).to.match(
          /does not have twakeDepartmentLink attribute/
        );
      } finally {
        await plugin.ldap.delete(noDeptGroupDn);
      }
    });

    it('should reject move to non-existent organization', async () => {
      const fakeOrgDn = `ou=nonexistent,${process.env.DM_LDAP_TOP_ORGANIZATION}`;
      try {
        await plugin.moveGroup('testgroup', fakeOrgDn);
        expect.fail('Should have thrown error');
      } catch (e) {
        expect((e as Error).message).to.match(/not found/);
      }
    });

    it('should move group via API', async () => {
      const request = supertest(server.app);
      plugin.api(server.app);

      const res = await request
        .post('/api/v1/ldap/groups/testgroup/move')
        .type('json')
        .send({
          targetOrgDn: org2Dn,
        });

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });

      // Verify group was moved
      const group = (await plugin.ldap.search(
        { paged: false, scope: 'base' },
        groupDn
      )) as SearchResult;
      expect(group.searchEntries[0].twakeDepartmentLink).to.equal(org2Dn);
      expect(group.searchEntries[0].twakeDepartmentPath).to.equal('Test Org 2');
    });

    it('should work with DN parameter', async () => {
      const result = await plugin.moveGroup(groupDn, org2Dn);
      expect(result).to.have.property('success', true);

      // Verify group was moved
      const group = (await plugin.ldap.search(
        { paged: false, scope: 'base' },
        groupDn
      )) as SearchResult;
      expect(group.searchEntries[0].twakeDepartmentLink).to.equal(org2Dn);
      expect(group.searchEntries[0].twakeDepartmentPath).to.equal('Test Org 2');
    });
  });
});
