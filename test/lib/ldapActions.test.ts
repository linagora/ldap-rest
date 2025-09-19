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

  describe('Modify entries', () => {
    before(function () {
      // Skip tests if env vars are not set
      if (!process.env.DM_LDAP_BASE) {
        // eslint-disable-next-line no-console
        console.warn('Skipping LDAP modify: DM_LDAP_BASE not set');
        // @ts-ignore
        this.skip();
      }
    });

    describe('add', () => {
      const testDN = `uid=testuser,${process.env.DM_LDAP_BASE}`;
      afterEach(async () => {
        // Clean up: delete the test entry if it exists
        try {
          await ldapActions.delete(testDN);
        } catch (err) {
          // Ignore errors if the entry does not exist
          console.error('Ignored', err);
        }
      });

      it('should add a new entry successfully', async () => {
        const entry = {
          objectClass: [
            'inetOrgPerson',
            'organizationalPerson',
            'person',
            'top',
          ],
          cn: 'Test User',
          sn: 'User',
          uid: 'testuser',
          mail: 'test@test.org',
        };
        const addResult = await ldapActions.add(testDN, entry);
        expect(addResult).to.be.true;

        // Verify the entry was added
        const searchOptions = {
          filter: '(uid=testuser)',
        };
        const searchResult = await ldapActions.search(searchOptions);
        if ((searchResult as SearchResult).searchEntries) {
          expect((searchResult as SearchResult).searchEntries.length).to.equal(
            1
          );
          expect((searchResult as SearchResult).searchEntries[0].dn).to.equal(
            testDN
          );
        } else {
          expect(searchResult);
        }
      });
    });
  });
});
