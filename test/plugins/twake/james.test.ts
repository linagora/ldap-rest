import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
  let dm: DM;
  let james: James;
  let ldapGroups: LdapGroups;
  let scope: nock.Scope;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      //.post(new RegExp('users/testmail@test.org/rename/t@t.org.*'))
      .persist()
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
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
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', ldapGroups);
    await dm.registerPlugin('james', james);
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

describe('James Mailing Lists', () => {
  const userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
  const groupBase =
    process.env.DM_LDAP_GROUP_BASE || `ou=groups,${process.env.DM_LDAP_BASE}`;
  const testGroupDN = `cn=testmailinglist,${groupBase}`;
  const testUser1DN = `uid=listmember1,${userBase}`;
  const testUser2DN = `uid=listmember2,${userBase}`;
  let dm: DM;
  let james: James;
  let ldapGroups: LdapGroups;
  let scope: nock.Scope;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    // Mock James API calls for mailing lists
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Create group members
      .put('/address/groups/list@test.org/member1@test.org')
      .reply(204)
      .put('/address/groups/list@test.org/member2@test.org')
      .reply(204)
      // Add new member
      .put('/address/groups/list@test.org/newmember@test.org')
      .reply(204)
      // Delete member
      .delete('/address/groups/list@test.org/member1@test.org')
      .reply(204)
      // Delete entire group
      .delete('/address/groups/list@test.org')
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

  beforeEach(async function () {
    // Increase timeout for setup
    this.timeout(5000);

    dm = new DM();
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    dm.registerPlugin('ldapGroups', ldapGroups);
    dm.registerPlugin('james', james);

    // Ensure ou=users exists
    try {
      await dm.ldap.add(userBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'users',
      });
    } catch (err) {
      // Ignore if already exists
    }

    // Clean up any leftover test users from failed tests
    const newUserDN = `uid=newmember,${userBase}`;
    try {
      await dm.ldap.delete(newUserDN);
    } catch (err) {
      // Ignore if doesn't exist
    }

    // Delete existing test users before recreating them
    try {
      await dm.ldap.delete(testUser1DN);
    } catch (err) {
      // Ignore if doesn't exist
    }

    try {
      await dm.ldap.delete(testUser2DN);
    } catch (err) {
      // Ignore if doesn't exist
    }

    // Create test users
    await dm.ldap.add(testUser1DN, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'List Member 1',
      sn: 'Member1',
      uid: 'listmember1',
      mail: 'member1@test.org',
    });

    await dm.ldap.add(testUser2DN, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'List Member 2',
      sn: 'Member2',
      uid: 'listmember2',
      mail: 'member2@test.org',
    });
  });

  afterEach(async () => {
    // Clean up test data
    try {
      await dm.ldap.delete(testGroupDN);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }

    try {
      await dm.ldap.delete(testUser1DN);
    } catch (err) {
      // Ignore
    }

    try {
      await dm.ldap.delete(testUser2DN);
    } catch (err) {
      // Ignore
    }
  });

  it('should create mailing list in James when group with mail is added', async () => {
    const res = await ldapGroups.addGroup(
      'testmailinglist',
      [testUser1DN, testUser2DN],
      {
        mail: 'list@test.org',
        twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
        twakeDepartmentPath: 'Test',
      }
    );
    expect(res).to.be.true;
  });

  it('should add member to James group when member is added to LDAP group', async function () {
    // Increase timeout for this test as it may be affected by timing issues
    this.timeout(10000);

    // First create the group
    await ldapGroups.addGroup('testmailinglist', [testUser1DN], {
      mail: 'list@test.org',
      twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
      twakeDepartmentPath: 'Test',
    });

    // Create a new user to add (use same base as other test users)
    const newUserDN = `uid=newmember,${userBase}`;
    try {
      await dm.ldap.add(newUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'New Member',
        sn: 'Member',
        uid: 'newmember',
        mail: 'newmember@test.org',
      });

      // Add member to group
      const res = await ldapGroups.addMember(testGroupDN, newUserDN);
      expect(res).to.be.true;
    } finally {
      try {
        await dm.ldap.delete(newUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should remove member from James group when member is deleted from LDAP group', async () => {
    // First create the group with two members
    await ldapGroups.addGroup('testmailinglist', [testUser1DN, testUser2DN], {
      mail: 'list@test.org',
      twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
      twakeDepartmentPath: 'Test',
    });

    // Remove one member
    const res = await ldapGroups.deleteMember(testGroupDN, testUser1DN);
    expect(res).to.be.true;
  });

  it('should delete mailing list from James when group is deleted', async () => {
    // First create the group
    await ldapGroups.addGroup('testmailinglist', [testUser1DN], {
      mail: 'list@test.org',
      twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
      twakeDepartmentPath: 'Test',
    });

    // Delete the group
    const res = await ldapGroups.deleteGroup(testGroupDN);
    expect(res).to.be.true;
  });

  it('should skip groups without mail attribute', async () => {
    // Track if James API was called (it shouldn't be)
    let jamesApiCalled = false;
    const tempScope = nock(
      process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
    )
      .put(/\/address\/groups\/.*/)
      .reply(function () {
        jamesApiCalled = true;
        return [200, {}];
      });

    // Create group without mail attribute
    const res = await ldapGroups.addGroup('testgroupnomail', [testUser1DN], {
      twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
      twakeDepartmentPath: 'Test',
    });
    expect(res).to.be.true;

    // Verify James API was NOT called
    expect(jamesApiCalled).to.be.false;

    // Clean up temp nock
    tempScope.persist(false);
    nock.cleanAll();

    // Clean up LDAP
    try {
      await dm.ldap.delete(`cn=testgroupnomail,${groupBase}`);
    } catch (err) {
      // Ignore
    }
  });
});
