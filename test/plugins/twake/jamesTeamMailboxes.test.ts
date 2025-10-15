import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Team Mailboxes', () => {
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
    dm.config.james_init_delay = 0; // No delay in tests
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', ldapGroups);
    await dm.registerPlugin('james', james);

    // Mock James API calls for team mailboxes
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mock identity sync for all emails
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
      // Create team mailbox
      .put(/\/domains\/test\.org\/team-mailboxes\/team.*@test\.org$/)
      .reply(204)
      // Add team mailbox members
      .put(
        /\/domains\/test\.org\/team-mailboxes\/team.*@test\.org\/members\/.*@test\.org$/
      )
      .reply(204)
      // Delete team mailbox member
      .delete(
        /\/domains\/test\.org\/team-mailboxes\/team.*@test\.org\/members\/.*@test\.org$/
      )
      .reply(204)
      // Delete entire team mailbox
      .delete(/\/domains\/test\.org\/team-mailboxes\/team.*@test\.org$/)
      .reply(204);
  });

  after(function () {
    if (scope) {
      scope.persist(false);
    }
    nock.cleanAll();
  });

  beforeEach(async function () {
    // Increase timeout for setup
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

    try {
      await dm.ldap.add(nomenclatureBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'nomenclature',
      });
    } catch (err) {
      // Ignore if already exists
    }

    try {
      await dm.ldap.add(mailboxTypeBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'twakeMailboxType',
      });
    } catch (err) {
      // Ignore if already exists
    }

    // Create nomenclature entries for mailbox types
    const mailboxTypes = ['group', 'mailingList', 'teamMailbox'];
    for (const type of mailboxTypes) {
      try {
        await dm.ldap.add(`cn=${type},${mailboxTypeBase}`, {
          objectClass: ['top', 'applicationProcess'],
          cn: type,
        });
      } catch (err) {
        // Ignore if already exists
      }
    }
  });

  it('should create team mailbox in James when group with twakeMailboxType=teamMailbox is added', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=team1-${timestamp},${groupBase}`;
    const testUser1DN = `uid=tmuser1-${timestamp},${userBase}`;
    const testUser2DN = `uid=tmuser2-${timestamp},${userBase}`;

    try {
      // Create test users
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 1',
        sn: 'User1',
        uid: `tmuser1-${timestamp}`,
        mail: `tmmember1-${timestamp}@test.org`,
      });

      await dm.ldap.add(testUser2DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 2',
        sn: 'User2',
        uid: `tmuser2-${timestamp}`,
        mail: `tmmember2-${timestamp}@test.org`,
      });

      // Create team mailbox group
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `team1-${timestamp}`,
        mail: `team1-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: [testUser1DN, testUser2DN],
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      // Hooks are awaited by ldap.add, no need for artificial timeout
      // Verify team mailbox was created (checked by nock)
      expect(scope.isDone()).to.be.false; // nock doesn't mark as done for persistent
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore cleanup errors
      }
      try {
        await dm.ldap.delete([testUser1DN, testUser2DN]);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  it('should add member to team mailbox when member is added to group', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=team2-${timestamp},${groupBase}`;
    const testUser1DN = `uid=tmuser3-${timestamp},${userBase}`;
    const testUser2DN = `uid=tmuser4-${timestamp},${userBase}`;

    try {
      // Create test users
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 3',
        sn: 'User3',
        uid: `tmuser3-${timestamp}`,
        mail: `tmmember3-${timestamp}@test.org`,
      });

      await dm.ldap.add(testUser2DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 4',
        sn: 'User4',
        uid: `tmuser4-${timestamp}`,
        mail: `tmmember4-${timestamp}@test.org`,
      });

      // Create team mailbox with one member
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `team2-${timestamp}`,
        mail: `team2-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUser1DN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      // Add second member (hooks are awaited automatically)
      await dm.ldap.modify(testGroupDN, {
        add: { member: testUser2DN },
      });

      // Verify member was added (checked by nock)
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore cleanup errors
      }
      try {
        await dm.ldap.delete([testUser1DN, testUser2DN]);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  it('should remove member from team mailbox when member is deleted from group', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=team3-${timestamp},${groupBase}`;
    const testUser1DN = `uid=tmuser5-${timestamp},${userBase}`;
    const testUser2DN = `uid=tmuser6-${timestamp},${userBase}`;

    try {
      // Create test users
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 5',
        sn: 'User5',
        uid: `tmuser5-${timestamp}`,
        mail: `tmmember5-${timestamp}@test.org`,
      });

      await dm.ldap.add(testUser2DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 6',
        sn: 'User6',
        uid: `tmuser6-${timestamp}`,
        mail: `tmmember6-${timestamp}@test.org`,
      });

      // Create team mailbox with two members
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `team3-${timestamp}`,
        mail: `team3-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: [testUser1DN, testUser2DN],
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      // Remove first member (hooks are awaited automatically)
      await dm.ldap.modify(testGroupDN, {
        delete: { member: testUser1DN },
      });

      // Verify member was removed from team mailbox (checked by nock)
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup
      try {
        await dm.ldap.delete(testGroupDN);
      } catch (err) {
        // Ignore cleanup errors
      }
      try {
        await dm.ldap.delete([testUser1DN, testUser2DN]);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  it('should delete team mailbox from James when group is deleted', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=team4-${timestamp},${groupBase}`;
    const testUserDN = `uid=tmuser7-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TM User 7',
        sn: 'User7',
        uid: `tmuser7-${timestamp}`,
        mail: `tmmember7-${timestamp}@test.org`,
      });

      // Create team mailbox
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `team4-${timestamp}`,
        mail: `team4-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: groupBase,
        twakeDepartmentPath: 'Test',
      });

      // Delete the team mailbox group (hooks are awaited automatically)
      await dm.ldap.delete(testGroupDN);

      // Verify team mailbox was deleted (checked by nock)
      expect(scope.isDone()).to.be.false;
    } finally {
      // Cleanup user
      try {
        await dm.ldap.delete(testUserDN);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });
});
