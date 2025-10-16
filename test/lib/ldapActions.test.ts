import LdapActions from '../../src/lib/ldapActions';
import { expect } from 'chai';
import { Client, SearchResult } from 'ldapts';
import { parseConfig } from '../../src/lib/parseConfig';
import configTemplate from '../../src/config/args';
import { DM } from '../../src/bin';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../helpers/env';

let ldapActions: LdapActions;

describe('ldapActions', function () {
  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  beforeEach(() => {
    ldapActions = new LdapActions(new DM());
  });

  describe('search', () => {
    it('should perform a search and return results', async () => {
      const options = {
        filter: '(uid=p*)',
        paged: false,
      };
      let result = await ldapActions.search(options);
      if (!(result as SearchResult).searchEntries) {
        const tmp = await (result as AsyncGenerator<SearchResult>).next();
        result = tmp.value;
      }
      expect(result).to.have.property('searchEntries');
      expect((result as SearchResult).searchEntries).to.be.an('array');
      expect((result as SearchResult).searchEntries.length).to.be.greaterThan(
        0
      );
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
        }
      });

      it('should add a new entry successfully, modify it and delete it successfully', async () => {
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
          paged: false,
        };
        const searchResult = await ldapActions.search(searchOptions);
        expect((searchResult as SearchResult).searchEntries.length).to.equal(1);
        expect((searchResult as SearchResult).searchEntries[0].dn).to.equal(
          testDN
        );

        await ldapActions.modify(testDN, {
          replace: { mail: 't@t.org' },
        });
        const modifiedResult = await ldapActions.search(searchOptions);
        expect((modifiedResult as SearchResult).searchEntries.length).to.equal(
          1
        );
        expect(
          (modifiedResult as SearchResult).searchEntries[0].mail
        ).to.include('t@t.org');

        await ldapActions.delete('testuser');
        let result = await ldapActions.search({ filter: '(uid=testuser)' });
        if (!(result as SearchResult).searchEntries) {
          const tmp = await (result as AsyncGenerator<SearchResult>).next();
          result = tmp.value;
        }
        expect((result as SearchResult).searchEntries.length).to.equal(0);
      });

      it('should fail to add an entry that already exists (this tests also an entry without objectClass)', async () => {
        const entry = {
          cn: 'Test User',
          sn: 'User',
          uid: 'testuser',
          mail: 'test@test.org',
        };
        // First add
        const firstAdd = await ldapActions.add(testDN, entry);
        expect(firstAdd).to.be.true;

        // Second add should fail
        try {
          await ldapActions.add(testDN, entry);
          expect.fail('Expected error not thrown');
        } catch (err) {
          expect(err).to.have.property('message');
        }
      });
    });

    describe('rename', () => {
      const testDN = `uid=testuser,${process.env.DM_LDAP_BASE}`;
      const newDN = `uid=newtestuser,${process.env.DM_LDAP_BASE}`;
      afterEach(async () => {
        // Clean up: delete the test entry if it exists
        try {
          await ldapActions.delete(testDN);
        } catch (err) {
          // Ignore errors if the entry does not exist
        }
        try {
          await ldapActions.delete(newDN);
        } catch (err) {
          // Ignore errors if the entry does not exist
        }
      });

      it('should rename an existing entry successfully', async () => {
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

        // Rename the entry
        const renameResult = await ldapActions.rename(testDN, newDN);
        expect(renameResult).to.be.true;

        // Verify the old DN no longer exists
        let result = await ldapActions.search({ filter: '(uid=testuser)' });
        if (!(result as SearchResult).searchEntries) {
          const tmp = await (result as AsyncGenerator<SearchResult>).next();
          result = tmp.value;
        }
        expect((result as SearchResult).searchEntries.length).to.equal(0);

        // Verify the new DN exists
        result = await ldapActions.search({ filter: '(uid=newtestuser)' });
        if (!(result as SearchResult).searchEntries) {
          const tmp = await (result as AsyncGenerator<SearchResult>).next();
          result = tmp.value;
        }
        expect((result as SearchResult).searchEntries.length).to.equal(1);
        expect((result as SearchResult).searchEntries[0].dn).to.equal(newDN);
        expect((result as SearchResult).searchEntries[0].uid).to.equal(
          'newtestuser'
        );
      });
    });
  });
});
