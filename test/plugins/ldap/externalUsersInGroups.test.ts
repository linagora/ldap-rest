import { expect } from 'chai';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { DM } from '../../../src/bin';
import ExternalUsersInGroups from '../../../src/plugins/ldap/externalUsersInGroups';
import { SearchResult } from 'ldapts';

const { DM_LDAP_GROUP_BASE } = process.env;
process.env.DM_GROUP_SCHEMA = '';

describe('External users in groups', function () {
  let server: DM;
  let plugin: LdapGroups;
  const user1 = `mail=toto@toto.org,${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;

  before(async () => {
    server = new DM();
    await server.ready;
    plugin = new LdapGroups(server);
    await server.registerPlugin('ldapGroups', plugin);
    await server.registerPlugin(
      'externalUsersInGroups',
      new ExternalUsersInGroups(server)
    );
  });

  afterEach(async () => {
    try {
      await plugin.deleteGroup('testgroup');
    } catch (e) {
      // ignore
    }
    try {
      await plugin.ldap.delete(user1);
    } catch (e) {
      // ignore
    }
  });

  it('should load externalUsersInGroups', () => {
    expect(plugin.constructor.name).to.equal('LdapGroups');
  });

  it('should accept external member in group', async () => {
    await plugin.addGroup('testgroup', [user1]);
    expect(await plugin.searchGroupsByName('testgroup')).to.deep.equal({
      testgroup: {
        dn: `cn=testgroup,${DM_LDAP_GROUP_BASE}`,
        cn: 'testgroup',
        member: [user1],
      },
    });
    expect(
      ((await plugin.ldap.search({ paged: false }, user1)) as SearchResult)
        .searchEntries[0]
    )
      .to.have.property('mail')
      .that.equals('toto@toto.org');
  });

  describe('Mail domain validation', function () {
    // Configured here rather than read from DM_MAIL_DOMAIN, which nothing
    // sets: the plugin reads mail_domain from the shared config on each call
    const managedDomain = 'managed.example.org';
    const managedUser = `mail=internal@${managedDomain},${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;
    let savedMailDomain: string[] | undefined;

    before(() => {
      savedMailDomain = server.config.mail_domain;
      server.config.mail_domain = [managedDomain];
    });

    after(() => {
      server.config.mail_domain = savedMailDomain;
    });

    afterEach(async () => {
      try {
        await plugin.deleteGroup('testgroup2');
      } catch (e) {
        // ignore
      }
      try {
        await plugin.ldap.delete(managedUser);
      } catch (e) {
        // ignore
      }
    });

    it('should reject external member with managed domain', async () => {
      try {
        await plugin.addGroup('testgroup2', [managedUser]);
        expect.fail('Should reject managed domain');
      } catch (e) {
        expect((e as Error).message).to.match(
          /Cannot create external user with managed domain/
        );
      }
    });

    it('should accept external member with non-managed domain', async () => {
      const externalUser = `mail=external@external-domain.org,${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;
      await plugin.addGroup('testgroup2', [externalUser]);
      expect(await plugin.searchGroupsByName('testgroup2')).to.deep.equal({
        testgroup2: {
          dn: `cn=testgroup2,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup2',
          member: [externalUser],
        },
      });
      expect(
        (
          (await plugin.ldap.search(
            { paged: false },
            externalUser
          )) as SearchResult
        ).searchEntries[0]
      )
        .to.have.property('mail')
        .that.equals('external@external-domain.org');

      // Delete user - the hook should automatically remove it from groups
      await plugin.ldap.delete(externalUser);

      // Verify user was removed from group by the hook
      expect(await plugin.searchGroupsByName('testgroup2')).to.deep.equal({
        testgroup2: {
          dn: `cn=testgroup2,${DM_LDAP_GROUP_BASE}`,
          cn: 'testgroup2',
          member: [],
        },
      });
    });
  });
});
