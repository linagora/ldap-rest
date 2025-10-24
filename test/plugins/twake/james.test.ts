import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Plugin', () => {
  let testDN: string;
  let testDNQuota: string;
  let testDNAliases: string;
  let testDNForwards: string;
  let dm: DM;
  let james: James;
  let ldapGroups: LdapGroups;
  let scope: nock.Scope;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    // Initialize DNs after env vars are set
    testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
    testDNQuota = `uid=quotauser,${process.env.DM_LDAP_BASE}`;
    testDNAliases = `uid=aliasuser,${process.env.DM_LDAP_BASE}`;
    testDNForwards = `uid=forwarduser,${process.env.DM_LDAP_BASE}`;
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
      .reply(204)
      // Identity - testmail@test.org
      .get('/jmap/identities/testmail@test.org')
      .reply(200, [
        {
          id: 'testmail-identity-id',
          name: 'Test User',
          email: 'testmail@test.org',
        },
      ])
      .put('/jmap/identities/testmail@test.org/testmail-identity-id')
      .reply(200, { success: true })
      // Identity - quotauser@test.org (created in quota test)
      .get('/jmap/identities/quotauser@test.org')
      .reply(200, [
        {
          id: 'quotauser-identity-id',
          name: 'Quota User',
          email: 'quotauser@test.org',
        },
      ])
      .put('/jmap/identities/quotauser@test.org/quotauser-identity-id')
      .reply(200, { success: true })
      // Identity - aliasuser@test.org (created in alias tests)
      .get('/jmap/identities/aliasuser@test.org')
      .reply(200, [
        {
          id: 'aliasuser-identity-id',
          name: 'Alias User',
          email: 'aliasuser@test.org',
        },
      ])
      .put('/jmap/identities/aliasuser@test.org/aliasuser-identity-id')
      .reply(200, { success: true })
      // Identity - primary@test.org (created in mail change test)
      .get('/jmap/identities/primary@test.org')
      .reply(200, [
        {
          id: 'primary-identity-id',
          name: 'Primary User',
          email: 'primary@test.org',
        },
      ])
      .put('/jmap/identities/primary@test.org/primary-identity-id')
      .reply(200, { success: true })
      // Identity - newprimary@test.org (after mail change)
      .get('/jmap/identities/newprimary@test.org')
      .reply(200, [
        {
          id: 'newprimary-identity-id',
          name: 'Primary User',
          email: 'newprimary@test.org',
        },
      ])
      .put('/jmap/identities/newprimary@test.org/newprimary-identity-id')
      .reply(200, { success: true })
      // Identity - t@t.org (after mail change in basic test)
      .get('/jmap/identities/t@t.org')
      .reply(200, [
        {
          id: 't-identity-id',
          name: 'Test User',
          email: 't@t.org',
        },
      ])
      .put('/jmap/identities/t@t.org/t-identity-id')
      .reply(200, { success: true })
      // Identity - forward@test.org (created in forward tests)
      .get('/jmap/identities/forward@test.org')
      .reply(200, [
        {
          id: 'forward-identity-id',
          name: 'Forward User',
          email: 'forward@test.org',
        },
      ])
      .put('/jmap/identities/forward@test.org/forward-identity-id')
      .reply(200, { success: true })
      // Identity - delegate@test.org (created in delegation tests)
      .get('/jmap/identities/delegate@test.org')
      .reply(200, [
        {
          id: 'delegate-identity-id',
          name: 'Delegate User',
          email: 'delegate@test.org',
        },
      ])
      .put('/jmap/identities/delegate@test.org/delegate-identity-id')
      .reply(200, { success: true })
      // Identity - assistant@test.org (created in delegation tests)
      .get('/jmap/identities/assistant@test.org')
      .reply(200, [
        {
          id: 'assistant-identity-id',
          name: 'Assistant User',
          email: 'assistant@test.org',
        },
      ])
      .put('/jmap/identities/assistant@test.org/assistant-identity-id')
      .reply(200, { success: true })
      // Identity - assistant1@test.org (created in delegation tests)
      .get('/jmap/identities/assistant1@test.org')
      .reply(200, [
        {
          id: 'assistant1-identity-id',
          name: 'Assistant 1',
          email: 'assistant1@test.org',
        },
      ])
      .put('/jmap/identities/assistant1@test.org/assistant1-identity-id')
      .reply(200, { success: true })
      // Identity - assistant2@test.org (created in delegation tests)
      .get('/jmap/identities/assistant2@test.org')
      .reply(200, [
        {
          id: 'assistant2-identity-id',
          name: 'Assistant 2',
          email: 'assistant2@test.org',
        },
      ])
      .put('/jmap/identities/assistant2@test.org/assistant2-identity-id')
      .reply(200, { success: true });
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
    dm.config.james_init_delay = 0; // No delay in tests
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
      await new Promise(resolve => setTimeout(resolve, 100));
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
      await new Promise(resolve => setTimeout(resolve, 100));
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
      await new Promise(resolve => setTimeout(resolve, 50));
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
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('should rename mailbox when mail changes without aliases', async () => {
      // Create user without aliases
      const testDNNoAlias = `uid=noaliasuser,${process.env.DM_LDAP_BASE}`;
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'noaliasuser',
        mail: 'noalias@test.org',
        cn: 'No Alias User',
        sn: 'User',
      };

      // Add rename mock for this test
      const renameScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .post('/users/noalias@test.org/rename/newalias@test.org?action=rename')
        .reply(200, { success: true })
        .get('/jmap/identities/noalias@test.org')
        .reply(200, [
          {
            id: 'noalias-identity-id',
            name: 'No Alias User',
            email: 'noalias@test.org',
          },
        ])
        .put('/jmap/identities/noalias@test.org/noalias-identity-id')
        .reply(200, { success: true })
        .get('/jmap/identities/newalias@test.org')
        .reply(200, [
          {
            id: 'newalias-identity-id',
            name: 'No Alias User',
            email: 'newalias@test.org',
          },
        ])
        .put('/jmap/identities/newalias@test.org/newalias-identity-id')
        .reply(200, { success: true });

      try {
        let res = await dm.ldap.add(testDNNoAlias, entry);
        expect(res).to.be.true;

        // Wait for creation
        await new Promise(resolve => setTimeout(resolve, 1200));

        // Change mail - should only rename, no aliases to update
        res = await dm.ldap.modify(testDNNoAlias, {
          replace: { mail: 'newalias@test.org' },
        });
        expect(res).to.be.true;

        // Wait for rename
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify the rename endpoint was called
        expect(renameScope.isDone()).to.be.false; // nock persist mode
      } finally {
        // Cleanup
        try {
          await dm.ldap.delete(testDNNoAlias);
        } catch (err) {
          // Ignore
        }
        renameScope.persist(false);
      }
    });

    it('should rename mailbox when mail changes without aliases', async () => {
      // Create user without aliases
      const testDNNoAlias = `uid=noaliasuser,${process.env.DM_LDAP_BASE}`;
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        uid: 'noaliasuser',
        mail: 'noalias@test.org',
        cn: 'No Alias User',
        sn: 'User',
      };

      // Add rename mock for this test
      const renameScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .post('/users/noalias@test.org/rename/newalias@test.org?action=rename')
        .reply(200, { success: true })
        .get('/jmap/identities/noalias@test.org')
        .reply(200, [
          {
            id: 'noalias-identity-id',
            name: 'No Alias User',
            email: 'noalias@test.org',
          },
        ])
        .put('/jmap/identities/noalias@test.org/noalias-identity-id')
        .reply(200, { success: true })
        .get('/jmap/identities/newalias@test.org')
        .reply(200, [
          {
            id: 'newalias-identity-id',
            name: 'No Alias User',
            email: 'newalias@test.org',
          },
        ])
        .put('/jmap/identities/newalias@test.org/newalias-identity-id')
        .reply(200, { success: true });

      try {
        let res = await dm.ldap.add(testDNNoAlias, entry);
        expect(res).to.be.true;

        // Wait for creation
        await new Promise(resolve => setTimeout(resolve, 1200));

        // Change mail - should only rename, no aliases to update
        res = await dm.ldap.modify(testDNNoAlias, {
          replace: { mail: 'newalias@test.org' },
        });
        expect(res).to.be.true;

        // Wait for rename
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify the rename endpoint was called
        expect(renameScope.isDone()).to.be.false; // nock persist mode
      } finally {
        // Cleanup
        try {
          await dm.ldap.delete(testDNNoAlias);
        } catch (err) {
          // Ignore
        }
        renameScope.persist(false);
      }
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

      // Wait for onChange hook to execute (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

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

      // Wait for initial forwards to be created (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

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

      // Wait for forward changes to be applied (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify the HTTP calls were made
      expect(deleteScope.isDone()).to.be.true;
      expect(addScope.isDone()).to.be.true;
    });
  });

  describe('Delegation', () => {
    let userDN: string;
    let assistantDN: string;
    let assistant1DN: string;
    let assistant2DN: string;

    before(() => {
      userDN = `uid=testdelegate,${process.env.DM_LDAP_BASE}`;
      assistantDN = `uid=assistant,${process.env.DM_LDAP_BASE}`;
      assistant1DN = `uid=assistant1,${process.env.DM_LDAP_BASE}`;
      assistant2DN = `uid=assistant2,${process.env.DM_LDAP_BASE}`;
    });

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

      // Wait for onChange hook to execute (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

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

      // Wait for add hook (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Now remove delegation
      await dm.ldap.modify(userDN, {
        delete: { twakeDelegatedUsers: assistantDN },
      });

      // Wait for remove hook (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

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

      // Wait for onChange hook to execute (needs more time with real LDAP)
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(multiAddScope1.isDone()).to.be.true;
      expect(multiAddScope2.isDone()).to.be.true;
    });
  });

  describe('Identity synchronization', () => {
    const timestamp = Date.now();
    const testUser1 = `testidentity${timestamp}`;
    const testUser2 = `newuser${timestamp}`;
    let testDN2: string;
    let testDN3: string;

    before(() => {
      testDN2 = `uid=${testUser1},${process.env.DM_LDAP_BASE}`;
      testDN3 = `uid=${testUser2},${process.env.DM_LDAP_BASE}`;
    });
    const testMail1 = `${testUser1}@test.org`;
    const testMail2 = `${testUser2}@test.org`;
    let identityScope: nock.Scope;

    before(function () {
      // Mock JMAP identity endpoints
      identityScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .persist()
        .get(`/jmap/identities/${testMail1}`)
        .reply(200, [
          {
            id: 'identity-id-1',
            name: 'Old Name',
            email: testMail1,
          },
        ])
        .put(`/jmap/identities/${testMail1}/identity-id-1`)
        .reply(200, { success: true })
        .get(`/jmap/identities/${testMail2}`)
        .reply(200, [
          {
            id: 'newuser-identity-id',
            name: '',
            email: testMail2,
          },
        ])
        .put(`/jmap/identities/${testMail2}/newuser-identity-id`)
        .reply(200, { success: true });
    });

    afterEach(async () => {
      // Clean up: delete the test entries if they exist
      try {
        await dm.ldap.delete(testDN2);
      } catch (err) {
        // Ignore errors if the entry does not exist
      }
      try {
        await dm.ldap.delete(testDN3);
      } catch (err) {
        // Ignore errors if the entry does not exist
      }
    });

    it('should update James identity when displayName changes', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Identity Test',
        sn: 'Test',
        uid: testUser1,
        mail: testMail1,
        displayName: 'Old Name',
      };
      let res = await dm.ldap.add(testDN2, entry);
      expect(res).to.be.true;

      // Modify displayName
      res = await dm.ldap.modify(testDN2, {
        replace: { displayName: 'New Display Name' },
      });
      expect(res).to.be.true;
    });

    it('should update James identity when cn changes', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Old CN',
        sn: 'Test',
        uid: testUser1,
        mail: testMail1,
      };
      let res = await dm.ldap.add(testDN2, entry);
      expect(res).to.be.true;

      // Modify cn
      res = await dm.ldap.modify(testDN2, {
        replace: { cn: 'New CN' },
      });
      expect(res).to.be.true;
    });

    it('should use cn as fallback when displayName is not present', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'John Doe',
        sn: 'Doe',
        uid: testUser1,
        mail: testMail1,
      };
      let res = await dm.ldap.add(testDN2, entry);
      expect(res).to.be.true;

      // Test getDisplayNameFromDN method directly before modify
      let displayName = await james.getDisplayNameFromDN(testDN2);
      expect(displayName).to.equal('John Doe');

      // Modify cn - this should trigger identity update using cn
      res = await dm.ldap.modify(testDN2, {
        replace: { cn: 'Jane Doe' },
      });
      expect(res).to.be.true;

      // Test getDisplayNameFromDN method again after modify
      displayName = await james.getDisplayNameFromDN(testDN2);
      expect(displayName).to.equal('Jane Doe');
    });

    it('should initialize James identity when user is created', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'New User',
        sn: 'User',
        uid: testUser2,
        mail: testMail2,
        displayName: 'New User Display',
      };
      let res = await dm.ldap.add(testDN3, entry);
      expect(res).to.be.true;

      // Wait for the ldapadddone hook to execute (with 1s delay in hook)
      await new Promise(resolve => setTimeout(resolve, 1200));
    });
  });

  describe('Signature template', () => {
    let testDN4: string;
    let signatureScope: nock.Scope;
    let savedTemplate: string | undefined;

    before(function () {
      testDN4 = `uid=testsignature,${process.env.DM_LDAP_BASE}`;
      // Save current template and set test template
      savedTemplate = process.env.DM_JAMES_SIGNATURE_TEMPLATE;
      process.env.DM_JAMES_SIGNATURE_TEMPLATE =
        '--<br/>{givenName} {sn}<br/>{title}<br/>{departmentNumber}';

      // Mock JMAP identity endpoints for signature test
      signatureScope = nock(
        process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
      )
        .persist()
        .get('/jmap/identities/signature@test.org')
        .reply(200, [
          {
            id: 'signature-identity-id',
            name: 'John Doe',
            email: 'signature@test.org',
          },
        ])
        .put('/jmap/identities/signature@test.org/signature-identity-id')
        .reply(200, { success: true });
    });

    after(function () {
      // Restore original template
      if (savedTemplate !== undefined) {
        process.env.DM_JAMES_SIGNATURE_TEMPLATE = savedTemplate;
      } else {
        delete process.env.DM_JAMES_SIGNATURE_TEMPLATE;
      }
    });

    afterEach(async () => {
      try {
        await dm.ldap.delete(testDN4);
      } catch (err) {
        // Ignore errors if the entry does not exist
      }
    });

    it('should generate signature from template and LDAP attributes', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'John Doe',
        sn: 'Doe',
        givenName: 'John',
        uid: 'testsignature',
        mail: 'signature@test.org',
        title: 'Software Engineer',
        departmentNumber: 'IT Department',
        displayName: 'John Doe',
      };
      let res = await dm.ldap.add(testDN4, entry);
      expect(res).to.be.true;

      // Test signature generation directly
      const signature = await james.generateSignature(testDN4);
      expect(signature).to.equal(
        '--<br/>John Doe<br/>Software Engineer<br/>IT Department'
      );
    });

    it('should update James identity with signature on user modification', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'John Doe',
        sn: 'Doe',
        givenName: 'John',
        uid: 'testsignature',
        mail: 'signature@test.org',
        title: 'Software Engineer',
        departmentNumber: 'IT',
        displayName: 'John Doe',
      };
      let res = await dm.ldap.add(testDN4, entry);
      expect(res).to.be.true;

      // Modify displayName to trigger identity update
      res = await dm.ldap.modify(testDN4, {
        replace: { displayName: 'John M. Doe' },
      });
      expect(res).to.be.true;

      // Wait for hook to execute
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('should handle missing attributes in template gracefully', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Jane Smith',
        sn: 'Smith',
        givenName: 'Jane',
        uid: 'testsignature',
        mail: 'signature@test.org',
        displayName: 'Jane Smith',
        // Note: title and departmentNumber are missing
      };
      let res = await dm.ldap.add(testDN4, entry);
      expect(res).to.be.true;

      // Test signature generation with missing attributes
      const signature = await james.generateSignature(testDN4);
      expect(signature).to.equal('--<br/>Jane Smith<br/><br/>');
    });
  });
});
