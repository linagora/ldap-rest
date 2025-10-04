import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
  const testDNForwards = `uid=forwarduser,${process.env.DM_LDAP_BASE}`;
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
    // Clean up: delete the test entries if they exist
    try {
      await dm.ldap.delete(testDN);
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
});
