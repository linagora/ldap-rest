import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Mailing Lists', () => {
  const timestamp = Date.now();
  let userBase: string;
  let groupBase: string;

  let dm: DM;
  let james: James;
  let ldapGroups: LdapGroups;
  let scope: nock.Scope;

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    // Initialize DNs after env vars are set
    userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
    groupBase =
      process.env.DM_LDAP_GROUP_BASE || `ou=groups,${process.env.DM_LDAP_BASE}`;

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

    // Mock James API calls for mailing lists
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mock identity sync for all emails (uses regex to match dynamic timestamps)
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
      // Create group members
      .put(/\/address\/groups\/list.*@test\.org\/member.*@test\.org$/)
      .reply(204)
      // Add new member
      .put(/\/address\/groups\/list.*@test\.org\/newmember.*@test\.org$/)
      .reply(204)
      // Delete member
      .delete(/\/address\/groups\/list.*@test\.org\/member.*@test\.org$/)
      .reply(204)
      // Delete entire group
      .delete(/\/address\/groups\/list.*@test\.org$/)
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

    // Ensure ou=users exists
    try {
      await dm.ldap.add(userBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'users',
      });
    } catch (err) {
      // Ignore if already exists
    }
  });

  it('should create mailing list in James when group with mail is added', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=mailinglist1-${timestamp},${groupBase}`;
    const testUser1DN = `uid=mluser1-${timestamp},${userBase}`;
    const testUser2DN = `uid=mluser2-${timestamp},${userBase}`;

    try {
      // Create test users
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 1',
        sn: 'User1',
        uid: `mluser1-${timestamp}`,
        mail: `member1-${timestamp}@test.org`,
      });

      await dm.ldap.add(testUser2DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 2',
        sn: 'User2',
        uid: `mluser2-${timestamp}`,
        mail: `member2-${timestamp}@test.org`,
      });

      const res = await ldapGroups.addGroup(
        `mailinglist1-${timestamp}`,
        [testUser1DN, testUser2DN],
        {
          mail: `list1-${timestamp}@test.org`,
          twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
          twakeDepartmentPath: 'Test',
        }
      );
      expect(res).to.be.true;
    } finally {
      // Cleanup
      for (const dn of [testGroupDN, testUser1DN, testUser2DN]) {
        try {
          await dm.ldap.delete(dn);
        } catch (err) {
          // Ignore
        }
      }
    }
  });

  it('should add member to James group when member is added to LDAP group', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=mailinglist2-${timestamp},${groupBase}`;
    const testUser1DN = `uid=mluser3-${timestamp},${userBase}`;
    const newUserDN = `uid=mluser4-${timestamp},${userBase}`;

    try {
      // Create initial user
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 3',
        sn: 'User3',
        uid: `mluser3-${timestamp}`,
        mail: `member1-${timestamp}@test.org`,
      });

      // Create the group
      await ldapGroups.addGroup(`mailinglist2-${timestamp}`, [testUser1DN], {
        mail: `list2-${timestamp}@test.org`,
        twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
        twakeDepartmentPath: 'Test',
      });

      // Create a new user to add
      await dm.ldap.add(newUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 4',
        sn: 'User4',
        uid: `mluser4-${timestamp}`,
        mail: `newmember-${timestamp}@test.org`,
      });

      // Add member to group
      const res = await ldapGroups.addMember(testGroupDN, newUserDN);
      expect(res).to.be.true;
    } finally {
      // Cleanup
      for (const dn of [testGroupDN, newUserDN, testUser1DN]) {
        try {
          await dm.ldap.delete(dn);
        } catch (err) {
          // Ignore
        }
      }
    }
  });

  it('should remove member from James group when member is deleted from LDAP group', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=mailinglist3-${timestamp},${groupBase}`;
    const testUser1DN = `uid=mluser5-${timestamp},${userBase}`;
    const testUser2DN = `uid=mluser6-${timestamp},${userBase}`;

    try {
      // Create test users
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 5',
        sn: 'User5',
        uid: `mluser5-${timestamp}`,
        mail: `member1-${timestamp}@test.org`,
      });

      await dm.ldap.add(testUser2DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 6',
        sn: 'User6',
        uid: `mluser6-${timestamp}`,
        mail: `member2-${timestamp}@test.org`,
      });

      // Create the group with two members
      await ldapGroups.addGroup(
        `mailinglist3-${timestamp}`,
        [testUser1DN, testUser2DN],
        {
          mail: `list3-${timestamp}@test.org`,
          twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
          twakeDepartmentPath: 'Test',
        }
      );

      // Remove one member
      const res = await ldapGroups.deleteMember(testGroupDN, testUser1DN);
      expect(res).to.be.true;
    } finally {
      // Cleanup
      for (const dn of [testGroupDN, testUser1DN, testUser2DN]) {
        try {
          await dm.ldap.delete(dn);
        } catch (err) {
          // Ignore
        }
      }
    }
  });

  it('should delete mailing list from James when group is deleted', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=mailinglist4-${timestamp},${groupBase}`;
    const testUser1DN = `uid=mluser7-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 7',
        sn: 'User7',
        uid: `mluser7-${timestamp}`,
        mail: `member1-${timestamp}@test.org`,
      });

      // Create the group
      await ldapGroups.addGroup(`mailinglist4-${timestamp}`, [testUser1DN], {
        mail: `list4-${timestamp}@test.org`,
        twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
        twakeDepartmentPath: 'Test',
      });

      // Delete the group
      const res = await ldapGroups.deleteGroup(testGroupDN);
      expect(res).to.be.true;
    } finally {
      // Cleanup
      for (const dn of [testGroupDN, testUser1DN]) {
        try {
          await dm.ldap.delete(dn);
        } catch (err) {
          // Ignore
        }
      }
    }
  });

  it('should skip groups without mail attribute', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=groupnomail5-${timestamp},${groupBase}`;
    const testUser1DN = `uid=mluser8-${timestamp},${userBase}`;

    try {
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

      // Create test user
      await dm.ldap.add(testUser1DN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'ML User 8',
        sn: 'User8',
        uid: `mluser8-${timestamp}`,
        mail: `member1-${timestamp}@test.org`,
      });

      // Create group without mail attribute
      const res = await ldapGroups.addGroup(
        `groupnomail5-${timestamp}`,
        [testUser1DN],
        {
          twakeDepartmentLink: `ou=organization,${process.env.DM_LDAP_BASE}`,
          twakeDepartmentPath: 'Test',
        }
      );
      expect(res).to.be.true;

      // Verify James API was NOT called
      expect(jamesApiCalled).to.be.false;

      // Clean up temp nock
      tempScope.persist(false);
    } finally {
      // Cleanup
      for (const dn of [testGroupDN, testUser1DN]) {
        try {
          await dm.ldap.delete(dn);
        } catch (err) {
          // Ignore
        }
      }
    }
  });
});
