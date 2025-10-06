import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
  const testDNQuota = `uid=quotauser,${process.env.DM_LDAP_BASE}`;
  const testDNAliases = `uid=aliasuser,${process.env.DM_LDAP_BASE}`;
  const testDNForwards = `uid=forwarduser,${process.env.DM_LDAP_BASE}`;
  let dm: DM;
  let james: James;
  let ldapGroups: LdapGroups;
  let scope: nock.Scope;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mail rename
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
      .reply(200, { success: true })
      .post('/users/primary@test.org/rename/newprimary@test.org?action=rename')
      .reply(200, { success: true })
      // Quota
      .put('/quota/users/testmail@test.org/size', '50000000')
      .reply(204)
      .put('/quota/users/testmail@test.org/size', '100000000')
      .reply(204)
      .put('/quota/users/quotauser@test.org/size', '75000000')
      .reply(204)
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
    if (scope) {
      scope.persist(false);
    }
    nock.cleanAll();
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    dm = new DM();
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', ldapGroups);
    await dm.registerPlugin('james', james);
  });

  afterEach(async () => {
    // Clean up: delete the test entries if they exist
    try {
      await dm.ldap.delete(testDN);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
    try {
      await dm.ldap.delete(testDNQuota);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
    try {
      await dm.ldap.delete(testDNAliases);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
    try {
      await dm.ldap.delete(testDNForwards);
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

  describe('Quota management', () => {
    it('should initialize quota when user is created', async () => {
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'quotauser',
        mail: 'quotauser@test.org',
        mailQuotaSize: '75000000',
      };
      const res = await dm.ldap.add(testDNQuota, entry);
      expect(res).to.be.true;

      // Wait for ldapadddone hook to execute
      await new Promise(resolve => setTimeout(resolve, 1200));
    });

    it('should update quota when modified in LDAP', async () => {
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'testusermail',
        mail: 'testmail@test.org',
        mailQuotaSize: '50000000',
      };
      let res = await dm.ldap.add(testDN, entry);
      expect(res).to.be.true;

      // Modify quota
      res = await dm.ldap.modify(testDN, {
        replace: { mailQuotaSize: '100000000' },
      });
      expect(res).to.be.true;
    });
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

  describe('Forward management', () => {
    it('should add forwards when mailForwardingAddress is added', async () => {
      const forwardScope1 = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/domains/test.org/forwards/forward@test.org/manager@test.org')
        .reply(204);

      const forwardScope2 = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/domains/test.org/forwards/forward@test.org/boss@test.org')
        .reply(204);

      // Create entry without forwards first
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'forwarduser',
        mail: 'forward@test.org',
      };
      let res = await dm.ldap.add(testDNForwards, entry);
      expect(res).to.be.true;

      // Add forwards via modify operation
      res = await dm.ldap.modify(testDNForwards, {
        add: {
          mailForwardingAddress: ['manager@test.org', 'boss@test.org'],
        },
      });
      expect(res).to.be.true;

      // Wait for hook to execute
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify the HTTP calls were made
      expect(forwardScope1.isDone()).to.be.true;
      expect(forwardScope2.isDone()).to.be.true;
    });

    it('should add and remove forwards when mailForwardingAddress is modified', async () => {
      // Scopes for initial forwards
      const initialScope1 = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/domains/test.org/forwards/forward@test.org/manager@test.org')
        .reply(204);

      const initialScope2 = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/domains/test.org/forwards/forward@test.org/boss@test.org')
        .reply(204);

      // Create user without forwards
      const entry = {
        objectClass: ['top', 'twakeAccount'],
        uid: 'forwarduser',
        mail: 'forward@test.org',
      };
      let res = await dm.ldap.add(testDNForwards, entry);
      expect(res).to.be.true;

      // Add initial forwards via modify
      res = await dm.ldap.modify(testDNForwards, {
        add: {
          mailForwardingAddress: ['manager@test.org', 'boss@test.org'],
        },
      });
      expect(res).to.be.true;

      // Wait for initial forwards to be created
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(initialScope1.isDone()).to.be.true;
      expect(initialScope2.isDone()).to.be.true;

      // Scopes for modification: delete manager, add assistant
      const deleteScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .delete('/domains/test.org/forwards/forward@test.org/manager@test.org')
        .reply(204);

      const addScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/domains/test.org/forwards/forward@test.org/assistant@test.org')
        .reply(204);

      // Modify forwards: remove manager, keep boss, add assistant
      res = await dm.ldap.modify(testDNForwards, {
        replace: {
          mailForwardingAddress: ['boss@test.org', 'assistant@test.org'],
        },
      });
      expect(res).to.be.true;

      // Wait for forward changes to be applied
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify the HTTP calls were made
      expect(deleteScope.isDone()).to.be.true;
      expect(addScope.isDone()).to.be.true;
    });
  });

  describe('Delegation', () => {
    const userDN = `uid=testdelegate,${process.env.DM_LDAP_BASE}`;
    const assistantDN = `uid=assistant,${process.env.DM_LDAP_BASE}`;
    const assistant1DN = `uid=assistant1,${process.env.DM_LDAP_BASE}`;
    const assistant2DN = `uid=assistant2,${process.env.DM_LDAP_BASE}`;
  
    beforeEach(async () => {
      // Create assistant user
      try {
        await dm.ldap.add(assistantDN, {
          objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
          cn: 'Assistant',
          sn: 'Assistant',
          uid: 'assistant',
          mail: 'assistant@test.org',
        });
      } catch (err) {
        // Ignore if already exists
      }
    });

    afterEach(async () => {
      try {
        await dm.ldap.delete(userDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(assistantDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(assistant1DN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(assistant2DN);
      } catch (err) {
        // Ignore
      }
    });

    it('should add delegation when twakeDelegatedUsers is added', async () => {
      let apiCalled = false;
      const addScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/users/delegate@test.org/authorizedUsers/assistant@test.org')
        .reply(200);

      addScope.on('request', () => {
        apiCalled = true;
      });

      const entry = {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        cn: 'Test Delegate',
        sn: 'Delegate',
        uid: 'testdelegate',
        mail: 'delegate@test.org',
      };
      await dm.ldap.add(userDN, entry);

      await dm.ldap.modify(userDN, {
        add: { twakeDelegatedUsers: assistantDN },
      });

      // Wait for hooks
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(apiCalled).to.be.true;
    });

    it('should remove delegation when twakeDelegatedUsers is removed', async () => {
      let addApiCalled = false;
      let removeApiCalled = false;

      const addScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/users/delegate@test.org/authorizedUsers/assistant@test.org')
        .reply(200);

      const removeScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .delete('/users/delegate@test.org/authorizedUsers/assistant@test.org')
        .reply(200);

      addScope.on('request', () => {
        addApiCalled = true;
      });

      removeScope.on('request', () => {
        removeApiCalled = true;
      });

      // First create user without delegation
      const entry = {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        cn: 'Test Delegate',
        sn: 'Delegate',
        uid: 'testdelegate',
        mail: 'delegate@test.org',
      };
      await dm.ldap.add(userDN, entry);

      // Add delegation
      await dm.ldap.modify(userDN, {
        add: { twakeDelegatedUsers: assistantDN },
      });

      // Wait for add hook
      await new Promise(resolve => setTimeout(resolve, 200));

      // Now remove delegation
      await dm.ldap.modify(userDN, {
        delete: { twakeDelegatedUsers: assistantDN },
      });

      // Wait for remove hook
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(removeApiCalled).to.be.true;
    });

    it('should handle multiple delegated users', async () => {
      // Create additional assistants
      await dm.ldap.add(assistant1DN, {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        cn: 'Assistant 1',
        sn: 'Assistant',
        uid: 'assistant1',
        mail: 'assistant1@test.org',
      });
      await dm.ldap.add(assistant2DN, {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        cn: 'Assistant 2',
        sn: 'Assistant',
        uid: 'assistant2',
        mail: 'assistant2@test.org',
      });

      const multiAddScope1 = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/users/delegate@test.org/authorizedUsers/assistant1@test.org')
        .reply(200);

      const multiAddScope2 = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .put('/users/delegate@test.org/authorizedUsers/assistant2@test.org')
        .reply(200);

      const entry = {
        objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
        cn: 'Test Delegate',
        sn: 'Delegate',
        uid: 'testdelegate',
        mail: 'delegate@test.org',
      };
      await dm.ldap.add(userDN, entry);

      await dm.ldap.modify(userDN, {
        add: {
          twakeDelegatedUsers: [assistant1DN, assistant2DN],
        },
      });

      // Wait for hooks
      await new Promise(resolve => setTimeout(resolve, 400));

      expect(multiAddScope1.isDone()).to.be.true;
      expect(multiAddScope2.isDone()).to.be.true;
    });
  });
});
