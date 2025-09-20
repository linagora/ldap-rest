import { expect } from 'chai';
import LdapGroups from '../../src/plugins/ldapGroups';
import { DM } from '../../src/bin';
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

  let ldapMock: any;
  let server: DM;
  let plugin: LdapGroups;

  before(() => {
    //process.env.DM_PLUGINS = 'core/ldapGroups';
    server = new DM();
    plugin = new LdapGroups(server);
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
      await plugin.addGroup('testgroup', [
        'uid=user1,ou=users,dc=example,dc=com',
      ]);
      const list = await plugin.listGroups();
      // @ts-ignore
      const listEntries = (await list.next()).value.searchEntries;
      expect(listEntries.length).to.be.greaterThan(0);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: ['uid=user1,ou=users,dc=example,dc=com'],
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
      await plugin.addGroup(
        'testgroup',
        ['uid=user1,ou=users,dc=example,dc=com'],
        { description: 'My test group' }
      );
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
          member: ['uid=user1,ou=users,dc=example,dc=com'],
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
          member: ['uid=user1,ou=users,dc=example,dc=com'],
          description: 'My modified test group',
        },
      });
      expect(await plugin.deleteGroup('testgroup')).to.be.true;
    });
  });

  describe('Manipulate member', () => {
    it('should add/delete member to group', async () => {
      await plugin.addGroup('testgroup');
      await plugin.addMember(
        'testgroup',
        'uid=user2,ou=users,dc=example,dc=com'
      );
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: ['uid=user2,ou=users,dc=example,dc=com'],
        },
      });
      await plugin.deleteMember(
        'testgroup',
        'uid=user2,ou=users,dc=example,dc=com'
      );
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: [],
        },
      });
    });
  });

  describe('API', () => {
    let request: any;
    before(() => {
      plugin.api(server.app);
      request = supertest(server.app);
    });

    it('should add/del group via API', async () => {
      let res = await request
        .post('/api/v1/ldap/groups/add')
        .type('json')
        .send({
          cn: 'testgroup',
          member: ['uid=user1,ou=users,dc=example,dc=com'],
        });
      expect(res.body).to.deep.equal({ success: true });
      expect(res.status).to.equal(200);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: {
          dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup',
          member: ['uid=user1,ou=users,dc=example,dc=com'],
        },
      });

      res = await request
        .post('/api/v1/ldap/groups/delete')
        .type('json')
        .send({ cn: 'testgroup' });
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ success: true });
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({});
    });
  });
});
