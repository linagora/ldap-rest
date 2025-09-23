import { expect } from 'chai';
import LdapGroups from '../../src/plugins/ldapGroups';
import { DM } from '../../src/bin';

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

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_PLUGINS = 'core/externalUsersInGroups';
    server = new DM();
    await server.ready;
    plugin = server.loadedPlugins.ldapGroups as unknown as LdapGroups;
  });

  it('should load externalUsersInGroups', () => {
    console.error('OK', plugin);
    expect(plugin.constructor.name).to.equal('LdapGroups');
    expect(plugin.server.loadedPlugins).to.have.key('externalUsersInGroups');
  });
});
