import { expect } from 'chai';
import LdapGroups from '../../src/plugins/ldapGroups';
import { DM } from '../../src/bin';
import ExternalUsersInGroups from '../../src/plugins/externalUsersInGroups';
import { SearchResult } from 'ldapts';

const { DM_LDAP_GROUP_BASE } = process.env;

describe('External users in groups', function () {
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
  const user1 = `mail=toto@toto.org,${process.env.DM_EXTERNAL_MEMBERS_BRANCH}`;

  before(async () => {
    server = new DM();
    await server.ready;
    plugin = new LdapGroups(server);
    server.registerPlugin('ldapGroups', plugin);
    server.registerPlugin(
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
});
