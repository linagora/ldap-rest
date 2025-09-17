import LdapActions from '../../src/lib/ldapActions';
import { expect } from 'chai';
import { Client } from 'ldapts';

let ldapActions: LdapActions;

describe('ldapActions', function () {
  before(function () {
    // Skip tests if env vars are not set
    if (!process.env.DM_LDAP_DN || !process.env.DM_LDAP_PWD) {
      // eslint-disable-next-line no-console
      console.warn('Skipping LDAP tests: DM_LDAP_DN or DM_LDAP_PWD not set');
      // @ts-ignore
      this.skip();
    }
  });

  beforeEach(() => {
    ldapActions = new LdapActions({
      ldap_url: 'ldap://localhost',
      ldap_dn: process.env.DM_LDAP_DN,
      ldap_pwd: process.env.DM_LDAP_PWD,
      port: 8081,
    });
  });

  describe('connect', () => {
    it('should connect to LDAP server successfully', async () => {
      const result = await ldapActions.connect();
      expect(result).to.be.instanceOf(Client);
      await result?.unbind();
    });
  });
});
