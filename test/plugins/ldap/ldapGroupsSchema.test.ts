import { expect } from 'chai';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import supertest from 'supertest';

const { DM_LDAP_GROUP_BASE } = process.env;

const twakeAttr = {
  twakeDepartmentPath: 'Test / SubTest',
  twakeDepartmentLink: `ou=Test,${process.env.DM_LDAP_GROUP_BASE}`,
};

describe('LdapGroups validation', function () {
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
      await plugin.addGroup('testgroup', [user1], twakeAttr);
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

    it('should not add group without required twake attributes', async () => {
      try {
        await plugin.addGroup('testgroup', [user1], {});
      } catch (e: any) {
        expect(e.message).to.match(/Missing required field/);
      }
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({});
    });
  });
});
