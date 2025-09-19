import LdapActions from '../../src/lib/ldapActions';
import { expect } from 'chai';
import { Client, SearchResult } from 'ldapts';
import { parseConfig } from '../../src/lib/parseConfig';
import configTemplate from '../../src/config/args';
import { DM } from '../../src/bin';

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
    ldapActions = new LdapActions(config, new DM());
  });

  describe('connect', () => {
    it('should connect to LDAP server successfully', async () => {
      const result = await ldapActions.connect();
      expect(result).to.be.instanceOf(Client);
      await result?.unbind();
    });
  });

  describe('search', () => {
    it('should perform a search and return results', async () => {
      const options = {
        filter: '(uid=p*)',
      };
      let result = await ldapActions.search(options);
      if (!(result as SearchResult).searchEntries) {
        const tmp = await (result as AsyncGenerator<SearchResult>).next();
        result = tmp.value;
      }
      expect(result).to.have.property('searchEntries');
      if ((result as SearchResult).searchEntries) {
        expect((result as SearchResult).searchEntries).to.be.an('array');
        expect((result as SearchResult).searchEntries.length).to.be.greaterThan(
          0
        );
      } else {
        expect(result);
      }
    });
  });
});
