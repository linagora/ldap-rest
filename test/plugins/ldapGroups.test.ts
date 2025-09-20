import { expect } from 'chai';
import LdapGroups from '../../src/plugins/ldapGroups';
import { parseConfig } from '../../src/lib/parseConfig';
import configTemplate from '../../src/config/args';
import { DM } from '../../src/bin';

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

  beforeEach(() => {
    process.env.DM_PLUGINS = 'core/ldapGroups';
    server = new DM();
    plugin = new LdapGroups(server);
  });

  describe('constructor', () => {
    it('should set base from config', () => {
      expect(plugin.base).to.equal(DM_LDAP_GROUP_BASE);
    });
  });

  describe('addGroup', () => {
    afterEach(async () => {
      try {
        await plugin.deleteGroup('testgroup');
      } catch (e) {
        // ignore
      }
    });

    it('should add/delete group with members', async () => {
      await plugin.addGroup('testgroup', [
        'uid=user1,ou=users,dc=example,dc=com',
      ]);
      const list = await plugin.listGroups();
      // @ts-ignore
      const listEntries = (await list.next()).value.searchEntries;
      expect(listEntries.length).to.be.greaterThan(0);
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: { dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`, cn: 'testgroup', member: ['uid=user1,ou=users,dc=example,dc=com'] },
      });
      expect(await plugin.deleteGroup('testgroup')).to.be.true;
    });

    it('should add group with dummy member if no members', async () => {
      await plugin.addGroup('testgroup');
      expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
        testgroup: { dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`, cn: 'testgroup', member: []},
      });
      expect(await plugin.deleteGroup('testgroup')).to.be.true;
    });

    /*
    it('should throw on ldap error', async () => {
      ldapMock.add.rejects(new Error('fail'));
      await expect(plugin.addGroup('failgroup')).to.be.rejectedWith(
        /Failed to add group/
      );
    });
    */
  });
  /*
  describe('deleteGroup', () => {
    it('should delete group', async () => {
      await plugin.deleteGroup('testgroup');
      expect(ldapMock.delete.calledOnce).to.be.true;
      expect(ldapMock.delete.firstCall.args[0]).to.include('cn=testgroup');
    });

    it('should throw on ldap error', async () => {
      ldapMock.delete.rejects(new Error('fail'));
      await expect(plugin.deleteGroup('failgroup')).to.be.rejectedWith(
        /Failed to delete group/
      );
    });
  });

  describe('addMember', () => {
    it('should add member to group', async () => {
      await plugin.addMember(
        'testgroup',
        'uid=user2,ou=users,dc=example,dc=com'
      );
      expect(ldapMock.modify.calledOnce).to.be.true;
      const [dn, mod] = ldapMock.modify.firstCall.args;
      expect(dn).to.include('cn=testgroup');
      expect(mod.add[0].member).to.equal(
        'uid=user2,ou=users,dc=example,dc=com'
      );
    });

    it('should throw on ldap error', async () => {
      ldapMock.modify.rejects(new Error('fail'));
      await expect(plugin.addMember('failgroup', 'member')).to.be.rejectedWith(
        /Failed to add member/
      );
    });
  });

  describe('deleteMember', () => {
    it('should delete member from group', async () => {
      await plugin.deleteMember(
        'testgroup',
        'uid=user2,ou=users,dc=example,dc=com'
      );
      expect(ldapMock.modify.calledOnce).to.be.true;
      const [dn, mod] = ldapMock.modify.firstCall.args;
      expect(dn).to.include('cn=testgroup');
      expect(mod.delete[0].member).to.equal(
        'uid=user2,ou=users,dc=example,dc=com'
      );
    });

    it('should throw on ldap error', async () => {
      ldapMock.modify.rejects(new Error('fail'));
      await expect(
        plugin.deleteMember('failgroup', 'member')
      ).to.be.rejectedWith(/Failed to delete member/);
    });
  });

  describe('deleteMemberFromAll', () => {
    it('should search and remove member from all groups', async () => {
      ldapMock.search.resolves({
        searchEntries: [
          { dn: 'cn=group1,' + DM_GROUP_BASE },
          { dn: 'cn=group2,' + DM_GROUP_BASE },
        ],
      });
      await plugin.deleteMemberFromAll('uid=user3,ou=users,dc=example,dc=com');
      expect(ldapMock.modify.callCount).to.equal(2);
    });

    it('should handle search error', async () => {
      ldapMock.search.rejects(new Error('fail'));
      await expect(plugin.deleteMemberFromAll('uid=fail')).to.be.rejectedWith(
        /Failed to search groups/
      );
    });
  });

  describe('listGroups', () => {
    it('should list group names', async () => {
      ldapMock.search.resolves({
        searchEntries: [{ cn: 'group1' }, { cn: 'group2' }],
      });
      const groups = await plugin.listGroups();
      expect(groups).to.deep.equal(['group1', 'group2']);
    });

    it('should handle search error', async () => {
      ldapMock.search.rejects(new Error('fail'));
      await expect(plugin.listGroups()).to.be.rejectedWith(
        /Failed to list groups/
      );
    });
  });

  describe('hooks.ldapdeleterequest', () => {
    it('should call deleteMemberFromAll for each dn', async () => {
      const spy = sinon.spy(plugin, 'deleteMemberFromAll');
      await plugin.hooks.ldapdeleterequest(
        'uid=user4,ou=users,dc=example,dc=com'
      );
      expect(spy.calledOnce).to.be.true;
    });

    it('should handle array of dns', async () => {
      const spy = sinon.spy(plugin, 'deleteMemberFromAll');
      await plugin.hooks.ldapdeleterequest([
        'uid=user5,ou=users,dc=example,dc=com',
        'uid=user6,ou=users,dc=example,dc=com',
      ]);
      expect(spy.calledTwice).to.be.true;
    });
  });
  */
});

// We recommend installing an extension to run mocha tests.
