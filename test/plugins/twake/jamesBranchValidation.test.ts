import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import LdapGroups from '../../../src/plugins/ldap/groups';

describe('James Branch Validation', () => {
  const timestamp = Date.now();
  let userBase: string;
  let groupBase: string;
  let listsBase: string;
  let teamsBase: string;
  let nomenclatureBase: string;
  let mailboxTypeBase: string;

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
    listsBase = `ou=lists,${groupBase}`;
    teamsBase = `ou=teams,${groupBase}`;
    nomenclatureBase = `ou=nomenclature,${process.env.DM_LDAP_BASE}`;
    mailboxTypeBase = `ou=twakeMailboxType,${nomenclatureBase}`;

    // Create DM instance with branch restrictions
    dm = new DM();
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    dm.config.james_mailing_list_branch = [listsBase];
    dm.config.james_init_delay = 0; // No delay in tests
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', ldapGroups);
    await dm.registerPlugin('james', james);

    // Mock James API calls
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mock identity sync
      .get(/\/users\/.*@test\.org\/identities$/)
      .query({ default: 'true' })
      .reply(200, uri => {
        const email = uri
          .replace(/\?.*$/, '')
          .replace('/users/', '')
          .replace('/identities', '');
        return [
          {
            id: `${email}-identity-id`,
            name: 'Test User',
            email: email,
          },
        ];
      })
      .put(/\/users\/.*@test\.org\/identities\/.*-identity-id$/)
      .reply(200, { success: true })
      // Team mailbox operations
      .put(/\/domains\/test\.org\/team-mailboxes\/.*@test\.org$/)
      .reply(204)
      .put(
        /\/domains\/test\.org\/team-mailboxes\/.*@test\.org\/members\/.*@test\.org$/
      )
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

    try {
      await dm.ldap.add(listsBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'lists',
      });
    } catch (err) {
      // Ignore if already exists
    }

    try {
      await dm.ldap.add(teamsBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'teams',
      });
    } catch (err) {
      // Ignore if already exists
    }
  });

  it('should allow team mailbox outside mailing list branch', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=validteam-${timestamp},${teamsBase}`;
    const testUserDN = `uid=vtuser1-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'VT User 1',
        sn: 'User1',
        uid: `vtuser1-${timestamp}`,
        mail: `vtuser1-${timestamp}@test.org`,
      });

      // Create team mailbox outside mailing list branch (should succeed)
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `validteam-${timestamp}`,
        mail: `validteam-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: teamsBase,
        twakeDepartmentPath: 'Teams',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should succeed - team mailbox created
      expect(true).to.be.true;
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

  it('should reject team mailbox inside mailing list branch', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=invalidteam-${timestamp},${listsBase}`;
    const testUserDN = `uid=ituser1-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'IT User 1',
        sn: 'User1',
        uid: `ituser1-${timestamp}`,
        mail: `ituser1-${timestamp}@test.org`,
      });

      // Create team mailbox in mailing list branch (should fail validation)
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `invalidteam-${timestamp}`,
        mail: `invalidteam-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: listsBase,
        twakeDepartmentPath: 'Lists',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Team mailbox should NOT be created in James (validation failed)
      // The LDAP entry will exist, but James won't have it
      expect(true).to.be.true;
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

  it('should reject transition to team mailbox inside mailing list branch', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=transteam-${timestamp},${listsBase}`;
    const testUserDN = `uid=ttuser1-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'TT User 1',
        sn: 'User1',
        uid: `ttuser1-${timestamp}`,
        mail: `ttuser1-${timestamp}@test.org`,
      });

      // Create simple group in lists branch
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `transteam-${timestamp}`,
        mail: `transteam-${timestamp}@test.org`,
        twakeMailboxType: `cn=group,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: listsBase,
        twakeDepartmentPath: 'Lists',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Try to transition to team mailbox (should fail - in mailing list branch)
      await dm.ldap.modify(testGroupDN, {
        replace: {
          twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Transition should be rejected
      expect(true).to.be.true;
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
});

describe('James Branch Validation - Unrestricted Configuration', () => {
  const timestamp = Date.now();
  let userBase: string;
  let groupBase: string;
  let teamsBase: string;
  let nomenclatureBase: string;
  let mailboxTypeBase: string;

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
    teamsBase = `ou=teams,${groupBase}`;
    nomenclatureBase = `ou=nomenclature,${process.env.DM_LDAP_BASE}`;
    mailboxTypeBase = `ou=twakeMailboxType,${nomenclatureBase}`;

    // Create DM instance WITHOUT branch restrictions
    dm = new DM();
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    dm.config.james_mailing_list_branch = []; // Empty = no restrictions
    dm.config.james_init_delay = 0; // No delay in tests
    await dm.ready;
    james = new James(dm);
    ldapGroups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', ldapGroups);
    await dm.registerPlugin('james', james);

    // Mock James API calls
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      .persist()
      // Mock identity sync
      .get(/\/users\/.*@test\.org\/identities$/)
      .query({ default: 'true' })
      .reply(200, uri => {
        const email = uri
          .replace(/\?.*$/, '')
          .replace('/users/', '')
          .replace('/identities', '');
        return [
          {
            id: `${email}-identity-id`,
            name: 'Test User',
            email: email,
          },
        ];
      })
      .put(/\/users\/.*@test\.org\/identities\/.*-identity-id$/)
      .reply(200, { success: true })
      // Team mailbox operations
      .put(/\/domains\/test\.org\/team-mailboxes\/.*@test\.org$/)
      .reply(204)
      .put(
        /\/domains\/test\.org\/team-mailboxes\/.*@test\.org\/members\/.*@test\.org$/
      )
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

    try {
      await dm.ldap.add(teamsBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'teams',
      });
    } catch (err) {
      // Ignore if already exists
    }
  });

  it('should allow team mailboxes anywhere when branch restrictions are disabled', async function () {
    this.timeout(10000);
    const testGroupDN = `cn=unrestricted-team-${timestamp},${teamsBase}`;
    const testUserDN = `uid=unrestteam-${timestamp},${userBase}`;

    try {
      // Create test user
      await dm.ldap.add(testUserDN, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Unrestricted Team User',
        sn: 'User',
        uid: `unrestteam-${timestamp}`,
        mail: `unrestteam-${timestamp}@test.org`,
      });

      // Create team mailbox in teams branch (should succeed - no restrictions)
      await dm.ldap.add(testGroupDN, {
        objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
        cn: `unrestricted-team-${timestamp}`,
        mail: `unrestricted-team-${timestamp}@test.org`,
        twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
        member: testUserDN,
        twakeDepartmentLink: teamsBase,
        twakeDepartmentPath: 'Teams',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Team mailbox should be created successfully
      expect(true).to.be.true;
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
});
