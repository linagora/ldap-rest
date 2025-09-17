import LdapActions from '../../src/lib/ldapActions';
import { expect } from 'chai';
import { Client } from 'ldapts';
import { parseConfig } from '../../src/lib/parseConfig';
import configTemplate from '../../src/config/args';

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
    const config = parseConfig(configTemplate);
    ldapActions = new LdapActions(config);
  });

  describe('connect', () => {
    it('should connect to LDAP server successfully', async () => {
      const result = await ldapActions.connect();
      expect(result).to.be.instanceOf(Client);
      await result?.unbind();
    });
  });
});
