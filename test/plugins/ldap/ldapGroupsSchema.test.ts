import { expect } from 'chai';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import supertest from 'supertest';

const { DM_LDAP_GROUP_BASE } = process.env;

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
      await plugin.addGroup('testgroup', [user1], {
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
      });
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
      await plugin.addGroup('testgroup', [], {
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
      });
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
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
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
      await plugin.addGroup('testgroup', [], {
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
      });
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
      await plugin.addGroup('testgroup', [], {
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
      });
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
      await plugin.addGroup('testgroup', [user1], {
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
      });
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
          twakeDepartmentPath: ['Test / SubTest'],
          twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
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
      await plugin.addGroup('testgroup', [], {
        twakeDepartmentPath: ['Test / SubTest'],
        twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
      });
      let res = await request
        .post('/api/v1/ldap/groups/testgroup/members')
        .type('json')
        .send({
          member: user2,
          twakeDepartmentPath: ['Test / SubTest'],
          twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
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
          twakeDepartmentPath: ['Test / SubTest'],
          twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
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
});
