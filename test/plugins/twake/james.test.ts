import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
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
      //.post(new RegExp('users/testmail@test.org/rename/t@t.org.*'))
      .persist()
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
      .reply(200, { success: true });
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
    // Clean up: delete the test entry if it exists
    try {
      await dm.ldap.delete(testDN);
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

  describe('Delegation', () => {
    const userDN = `uid=testdelegate,${process.env.DM_LDAP_BASE}`;
    const assistantDN = `uid=assistant,${process.env.DM_LDAP_BASE}`;
    const assistant1DN = `uid=assistant1,${process.env.DM_LDAP_BASE}`;
    const assistant2DN = `uid=assistant2,${process.env.DM_LDAP_BASE}`;
    let delegateAddScope: nock.Scope;
    let delegateRemoveScope: nock.Scope;

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
