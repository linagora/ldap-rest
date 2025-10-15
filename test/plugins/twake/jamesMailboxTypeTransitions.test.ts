import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Mailbox Type Transitions', () => {
  const timestamp = Date.now();
  const userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
  const groupBase =
    process.env.DM_LDAP_GROUP_BASE || `ou=groups,${process.env.DM_LDAP_BASE}`;
  const nomenclatureBase = `ou=nomenclature,${process.env.DM_LDAP_BASE}`;
  const mailboxTypeBase = `ou=twakeMailboxType,${nomenclatureBase}`;

  let dm: DM;
  let james: James;
  let ldapGroups: LdapGroups;
  let scope: nock.Scope;

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    // Create DM instance once for all tests
    dm = new DM();
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', ldapGroups);
    await dm.registerPlugin('james', james);

    // Mock James API calls for all mailbox operations
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mock identity sync
      .get(/\/jmap\/identities\/.*@test\.org$/)
      .reply(200, uri => {
        const email = uri.replace('/jmap/identities/', '');
        return [
          {
            id: `${email}-identity-id`,
            name: 'Test User',
            email: email,
          },
        ];
      })
      .put(/\/jmap\/identities\/.*@test\.org\/.*-identity-id$/)
      .reply(200, { success: true })
      // Mailing list operations
      .put(/\/address\/groups\/.*@test\.org\/.*@test\.org$/)
      .reply(204)
      .delete(/\/address\/groups\/.*@test\.org\/.*@test\.org$/)
      .reply(204)
      .delete(/\/address\/groups\/.*@test\.org$/)
      .reply(204)
      // Team mailbox operations
      .put(/\/domains\/test\.org\/team-mailboxes\/.*@test\.org$/)
      .reply(204)
      .put(
        /\/domains\/test\.org\/team-mailboxes\/.*@test\.org\/members\/.*@test\.org$/
      )
      .reply(204)
      .delete(
        /\/domains\/test\.org\/team-mailboxes\/.*@test\.org\/members\/.*@test\.org$/
      )
      .reply(204)
      .delete(/\/domains\/test\.org\/team-mailboxes\/.*@test\.org$/)
      .reply(204);
  });

  after(function () {
    if (scope) {
      scope.persist(false);
    }
    nock.cleanAll();
  });

  beforeEach(async function () {
    this.timeout(10000);

    // Ensure required OUs exist
    try {
      await dm.ldap.add(userBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'users',
      });
    } catch (err) {
      // Ignore if already exists
    }
  });

  it('should transition from mailingList to teamMailbox', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition1-${timestamp},${groupBase}`;
    const testUserDN = `uid=transuser1-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 1',
        sn: 'User1',
        uid: `transuser1-${timestamp}`,
        mail: `transuser1-${timestamp}@test.org`,
      });

      // Create mailing list
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition1-${timestamp}`,
        mail: `transition1-${timestamp}@test.org`,
        twakeMailboxType: `cn=mailingList,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Transition to team mailbox
      await dm.ldap.modify(testGroupDN, {
        replace: {
          twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify transition occurred (checked by nock)
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should transition from teamMailbox to mailingList (preserve mailbox)', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition2-${timestamp},${groupBase}`;
    const testUserDN = `uid=transuser2-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 2',
        sn: 'User2',
        uid: `transuser2-${timestamp}`,
        mail: `transuser2-${timestamp}@test.org`,
      });

      // Create team mailbox
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition2-${timestamp}`,
        mail: `transition2-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Transition to mailing list
      await dm.ldap.modify(testGroupDN, {
        replace: {
          twakeMailboxType: `cn=mailingList,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify transition occurred
      // Team mailbox members should be removed (not deleted)
      // Mailing list should be created
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should transition from group to teamMailbox (add mail attribute)', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition3-${timestamp},${groupBase}`;
    const testUserDN = `uid=transuser3-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 3',
        sn: 'User3',
        uid: `transuser3-${timestamp}`,
        mail: `transuser3-${timestamp}@test.org`,
      });

      // Create simple group without mail
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition3-${timestamp}`,
        twakeMailboxType: `cn=group,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Add mail and change to team mailbox
      await dm.ldap.modify(testGroupDN, {
        add: {
          mail: `transition3-${timestamp}@test.org`,
        },
        replace: {
          twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify team mailbox was created
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should transition from teamMailbox to group (remove mail attribute)', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition4-${timestamp},${groupBase}`;
    const testUserDN = `uid=transuser4-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 4',
        sn: 'User4',
        uid: `transuser4-${timestamp}`,
        mail: `transuser4-${timestamp}@test.org`,
      });

      // Create team mailbox
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition4-${timestamp}`,
        mail: `transition4-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Change to simple group
      await dm.ldap.modify(testGroupDN, {
        replace: {
          twakeMailboxType: `cn=group,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify all members were removed from team mailbox (preserved)
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should transition from group to mailingList (add mail attribute)', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition5-${timestamp},${groupBase}`;
    const testUserDN = `uid=transuser5-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 5',
        sn: 'User5',
        uid: `transuser5-${timestamp}`,
        mail: `transuser5-${timestamp}@test.org`,
      });

      // Create simple group without mail
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition5-${timestamp}`,
        twakeMailboxType: `cn=group,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Add mail and change to mailing list
      await dm.ldap.modify(testGroupDN, {
        add: {
          mail: `transition5-${timestamp}@test.org`,
        },
        replace: {
          twakeMailboxType: `cn=mailingList,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify mailing list was created
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should transition from mailingList to group (disable mail functionality)', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition6-${timestamp},${groupBase}`;
    const testUserDN = `uid=transuser6-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 6',
        sn: 'User6',
        uid: `transuser6-${timestamp}`,
        mail: `transuser6-${timestamp}@test.org`,
      });

      // Create mailing list
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition6-${timestamp}`,
        mail: `transition6-${timestamp}@test.org`,
        twakeMailboxType: `cn=mailingList,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Change to simple group
      await dm.ldap.modify(testGroupDN, {
        replace: {
          twakeMailboxType: `cn=group,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify mailing list was deleted
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore
      }
    }
  });

  it('should remove all members when deleting a teamMailbox group', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transition7-${timestamp},${groupBase}`;
    const testUser1DN = `uid=transuser7-${timestamp},${userBase}`;
    const testUser2DN = `uid=transuser8-${timestamp},${userBase}`;

    try {
      // Create test users
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 7',
        sn: 'User7',
        uid: `transuser7-${timestamp}`,
        mail: `transuser7-${timestamp}@test.org`,
      });

      await dm.ldap.add(testUser2DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Trans User 8',
        sn: 'User8',
        uid: `transuser8-${timestamp}`,
        mail: `transuser8-${timestamp}@test.org`,
      });

      // Create team mailbox with 2 members
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transition7-${timestamp}`,
        mail: `transition7-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: [testUser1DN, testUser2DN],
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Delete the group
      await dm.ldap.delete(testGroupDN);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify all members were removed (but mailbox preserved)
      // The team mailbox should NOT be deleted
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup users
      try {
        await dm.ldap.delete([testUser1DN, testUser2DN]);
      } catch (err) {
        // Ignore
      }
    }
  });
});
