import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
  const testDNAliases = `uid=aliasuser,${process.env.DM_LDAP_BASE}`;
  let dm: DM;
  let james: James;
  let scope: nock.Scope;

  before(function () {
    // Skip tests if env vars are not set
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping LDAP tests: DM_LDAP_DN or DM_LDAP_PWD or DM_LDAP_BASE not set'
      );
      (this as Mocha.Context).skip();
    }
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mail rename
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
      .reply(200, { success: true })
      .post('/users/primary@test.org/rename/newprimary@test.org?action=rename')
      .reply(200, { success: true })
      // Alias creation on user add
      .put('/address/aliases/aliasuser@test.org/sources/alias1@test.org')
      .reply(204)
      .put('/address/aliases/aliasuser@test.org/sources/alias2@test.org')
      .reply(204)
      // Alias modification
      .put('/address/aliases/aliasuser@test.org/sources/alias3@test.org')
      .reply(204)
      .delete('/address/aliases/aliasuser@test.org/sources/alias1@test.org')
      .reply(204)
      // Aliases update on mail change
      .delete('/address/aliases/primary@test.org/sources/alias1@test.org')
      .reply(204)
      .delete('/address/aliases/primary@test.org/sources/alias2@test.org')
      .reply(204)
      .put('/address/aliases/newprimary@test.org/sources/alias1@test.org')
      .reply(204)
      .put('/address/aliases/newprimary@test.org/sources/alias2@test.org')
      .reply(204);
    nock.disableNetConnect();
  });

  after(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
    james = new James(dm);
    dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    dm.registerPlugin('james', james);
  });

  afterEach(async () => {
    // Clean up: delete the test entries if they exist
    try {
      await dm.ldap.delete(testDN);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
    try {
      await dm.ldap.delete(testDNAliases);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
  });

  it("should try to rename mailbox via James's webadmin", async () => {
    const entry = {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'Test User',
      sn: 'User',
      uid: 'testusermail',
      mail: 'testmail@test.org',
    };
    let res = await dm.ldap.add(testDN, entry);
    expect(res).to.be.true;
    res = await dm.ldap.modify(testDN, {
      replace: { mail: 't@t.org' },
    });
    expect(res).to.be.true;
  });

  describe('Alias management', () => {
    it('should create aliases when user is added with mailAlternateAddress', async () => {
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'aliasuser',
        mail: 'aliasuser@test.org',
        mailAlternateAddress: ['alias1@test.org', 'alias2@test.org'],
      };
      const res = await dm.ldap.add(testDNAliases, entry);
      expect(res).to.be.true;

      // Wait for ldapadddone hook to execute
      await new Promise(resolve => setTimeout(resolve, 1200));
    });

    it('should add and remove aliases when mailAlternateAddress is modified', async () => {
      // Create user with initial aliases
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'aliasuser',
        mail: 'aliasuser@test.org',
        mailAlternateAddress: ['alias1@test.org', 'alias2@test.org'],
      };
      let res = await dm.ldap.add(testDNAliases, entry);
      expect(res).to.be.true;

      // Wait for initial aliases to be created
      await new Promise(resolve => setTimeout(resolve, 1200));

      // Modify aliases: remove alias1, keep alias2, add alias3
      res = await dm.ldap.modify(testDNAliases, {
        replace: {
          mailAlternateAddress: ['alias2@test.org', 'alias3@test.org'],
        },
      });
      expect(res).to.be.true;

      // Wait for alias changes to be applied
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    it('should update all aliases when primary mail changes', async () => {
      // Create user with mail and aliases
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'aliasuser',
        mail: 'primary@test.org',
        mailAlternateAddress: ['alias1@test.org', 'alias2@test.org'],
      };
      let res = await dm.ldap.add(testDNAliases, entry);
      expect(res).to.be.true;

      // Wait for initial aliases to be created
      await new Promise(resolve => setTimeout(resolve, 1200));

      // Change primary mail - aliases should be updated to point to new mail
      res = await dm.ldap.modify(testDNAliases, {
        replace: { mail: 'newprimary@test.org' },
      });
      expect(res).to.be.true;

      // Wait for aliases to be updated
      await new Promise(resolve => setTimeout(resolve, 500));
    });
  });
});
