import { DM } from '../../../src/bin';
import AppAccountsConsistency from '../../../src/plugins/twake/appAccountsConsistency';
import OnChange from '../../../src/plugins/ldap/onChange';
import { expect } from 'chai';

describe('App Accounts Consistency Plugin', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping App Accounts Consistency tests: DM_LDAP_DN or DM_LDAP_PWD or DM_LDAP_BASE not set'
    );
    // @ts-ignore
    this.skip?.();
    return;
  }

  let applicativeBase: string;
  let userBase: string;
  let testUserDN: string;
  let testApplicativeDN: string;
  let dm: DM;
  let appAccountsConsistency: AppAccountsConsistency;

  beforeEach(async function () {
    this.timeout(10000);

    dm = new DM();
    dm.config.ldap_base = process.env.DM_LDAP_BASE;
    await dm.ready;

    // Initialize bases
    userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
    applicativeBase = `ou=applicative,${process.env.DM_LDAP_BASE}`;

    testUserDN = `uid=testuser,${userBase}`;
    testApplicativeDN = `uid=testuser@example.com,${applicativeBase}`;

    // Ensure ou=users exists
    try {
      await dm.ldap.add(userBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'users',
      });
    } catch (err) {
      // Ignore if already exists
    }

    // Ensure ou=applicative exists
    try {
      await dm.ldap.add(applicativeBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'applicative',
      });
    } catch (err) {
      // Ignore if already exists
    }

    // Configure and register plugins
    dm.config.applicative_account_base = applicativeBase;
    dm.config.mail_attribute = 'mail';

    // Register onChange plugin (dependency)
    const onChange = new OnChange(dm);
    await dm.registerPlugin('onLdapChange', onChange);

    appAccountsConsistency = new AppAccountsConsistency(dm);
    await dm.registerPlugin('appAccountsConsistency', appAccountsConsistency);
  });

  afterEach(async () => {
    // Clean up test data - delete all possible test entries
    const testDNs = [
      testUserDN,
      testApplicativeDN,
      `uid=testuser2,${userBase}`,
      `uid=testuser2,${applicativeBase}`,
      // Cleanup for mail change tests
      `uid=newemail@example.com,${applicativeBase}`,
      `uid=testuser_c12345678,${applicativeBase}`,
      `uid=testuser_c87654321,${applicativeBase}`,
    ];

    for (const dn of testDNs) {
      try {
        await dm.ldap.delete(dn);
      } catch (err) {
        // Ignore if doesn't exist
      }
    }
  });

  describe('User creation with mail', () => {
    it('should create applicative account when user with mail is added', async () => {
      // Create user with mail attribute
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);

      // Wait a bit for hook to execute
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify applicative account was created
      const result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        testApplicativeDN
      );

      expect((result as any).searchEntries).to.have.lengthOf(1);
      const entry = (result as any).searchEntries[0];
      expect(entry.uid).to.equal('testuser@example.com');
      expect(entry.mail).to.equal('testuser@example.com');
      expect(entry.cn).to.equal('Test User');
    });

    it('should be idempotent when creating applicative account multiple times', async () => {
      // Create user with mail
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Trigger creation again by modifying mail to same value
      await dm.ldap.modify(testUserDN, {
        replace: { mail: 'testuser@example.com' },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still have only one applicative account
      const result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        testApplicativeDN
      );

      expect((result as any).searchEntries).to.have.lengthOf(1);
    });

    it('should handle gracefully when user is deleted before account creation completes', async () => {
      // This tests the race condition handling
      // Create user
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);

      // Immediately delete user (race condition)
      await dm.ldap.delete(testUserDN);

      // Wait for hooks to execute
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify no errors were thrown and account may or may not exist
      // (this is acceptable - the important thing is no crash)
    });

    it('should not create applicative account when user without mail is added', async () => {
      const testUserDN2 = `uid=testuser2,${userBase}`;

      // Create user without mail attribute
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser2',
        cn: 'Test User 2',
        sn: 'User',
      };

      await dm.ldap.add(testUserDN2, userAttrs);

      // Wait a bit for hook to execute
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify no applicative account was created
      const testApplicativeDN2 = `uid=testuser2,${applicativeBase}`;
      try {
        const result = await dm.ldap.search(
          {
            scope: 'base',
            paged: false,
          },
          testApplicativeDN2
        );
        // Should not reach here if no entry exists
        const entries = (result as any).searchEntries || [];
        expect(entries).to.have.lengthOf(0);
      } catch (err: any) {
        // NoSuchObjectError is expected - the applicative account doesn't exist
        expect(err.message || err.code).to.match(/No such object|0x20/i);
      }

      // Cleanup
      await dm.ldap.delete(testUserDN2);
    });
  });

  describe('User deletion', () => {
    it('should delete applicative account when user is deleted', async () => {
      // Create user with mail attribute
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);

      // Wait for applicative account creation
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify applicative account exists
      let result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        testApplicativeDN
      );
      expect((result as any).searchEntries).to.have.lengthOf(1);

      // Delete user
      await dm.ldap.delete(testUserDN);

      // Wait for hook to execute
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify applicative account was deleted
      try {
        const result = await dm.ldap.search(
          {
            scope: 'base',
            paged: false,
          },
          testApplicativeDN
        );
        // Should not reach here if entry was deleted
        const entries = (result as any).searchEntries || [];
        expect(entries).to.have.lengthOf(0);
      } catch (err: any) {
        // NoSuchObjectError is expected - the applicative account was deleted
        expect(err.message || err.code).to.match(/No such object|0x20/i);
      }
    });

    it('should delete multiple applicative accounts when user is deleted', async function () {
      this.timeout(10000);

      // Create user
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'P@ssw0rd!123',
      };

      await dm.ldap.add(testUserDN, userAttrs);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create multiple app accounts
      const appAccount1DN = `uid=testuser_c11111111,${applicativeBase}`;
      const appAccount2DN = `uid=testuser_c22222222,${applicativeBase}`;
      const appAccount3DN = `uid=testuser_c33333333,${applicativeBase}`;

      await dm.ldap.add(appAccount1DN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser_c11111111',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'A1b2@-C3d4$-E5f6!-G7h8#-J9k0%-L1m2@',
      });

      await dm.ldap.add(appAccount2DN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser_c22222222',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'M3n4!-P5q6@-R7s8#-T9u0$-V1w2%-X3y4@',
      });

      await dm.ldap.add(appAccount3DN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser_c33333333',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'Z1a2!-B3c4@-D5e6#-F7g8$-H9i0%-J1k2@',
      });

      // Delete user (should trigger deletion of all accounts)
      await dm.ldap.delete(testUserDN);
      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify all accounts were deleted
      const accountsToCheck = [
        testApplicativeDN,
        appAccount1DN,
        appAccount2DN,
        appAccount3DN,
      ];

      for (const dn of accountsToCheck) {
        try {
          await dm.ldap.search(
            {
              scope: 'base',
              paged: false,
            },
            dn
          );
          expect.fail(`Account ${dn} should have been deleted`);
        } catch (err: any) {
          expect(err.message || err.code).to.match(/No such object|0x20/i);
        }
      }
    });

    it('should handle deletion when user has no applicative account', async () => {
      // Create user without mail
      const testUserDN2 = `uid=testuser2,${userBase}`;
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser2',
        cn: 'Test User 2',
        sn: 'User',
      };

      await dm.ldap.add(testUserDN2, userAttrs);

      // Delete user
      await dm.ldap.delete(testUserDN2);

      // Wait for hook to execute (should not error)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test passes if no error was thrown
    });

    it('should be idempotent when deleting already deleted accounts', async () => {
      // Create user
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Manually delete applicative account first
      await dm.ldap.delete(testApplicativeDN);

      // Then delete user (should not error even though account already deleted)
      await dm.ldap.delete(testUserDN);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test passes if no error was thrown
    });
  });

  describe('Mail change', () => {
    it('should update applicative account when user mail changes', async () => {
      // Create user with mail
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);

      // Wait for applicative account creation
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify applicative account exists
      let result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        testApplicativeDN
      );
      expect((result as any).searchEntries).to.have.lengthOf(1);

      // Change user's mail
      await dm.ldap.modify(testUserDN, {
        replace: { mail: 'newemail@example.com' },
      });

      // Wait for applicative account update (hooks are async)
      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify old applicative account is deleted
      try {
        await dm.ldap.search(
          {
            scope: 'base',
            paged: false,
          },
          testApplicativeDN
        );
        expect.fail('Old applicative account should have been deleted');
      } catch (err: any) {
        expect(err.message || err.code).to.match(/No such object|0x20/i);
      }

      // Verify new applicative account exists
      const newApplicativeDN = `uid=newemail@example.com,${applicativeBase}`;
      result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        newApplicativeDN
      );
      expect((result as any).searchEntries).to.have.lengthOf(1);
      const entry = (result as any).searchEntries[0];
      expect(entry.uid).to.equal('newemail@example.com');
      expect(entry.mail).to.equal('newemail@example.com');

      // Cleanup
      await dm.ldap.delete(newApplicativeDN);
    });

    it('should handle mail change when no applicative accounts exist', async () => {
      // Create user
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      };

      await dm.ldap.add(testUserDN, userAttrs);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Manually delete applicative account
      await dm.ldap.delete(testApplicativeDN);

      // Change mail (should handle gracefully with no accounts to update)
      await dm.ldap.modify(testUserDN, {
        replace: { mail: 'newemail@example.com' },
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify no new account was created (updateApplicativeAccount returns when no accounts found)
      const newApplicativeDN = `uid=newemail@example.com,${applicativeBase}`;
      try {
        await dm.ldap.search(
          {
            scope: 'base',
            paged: false,
          },
          newApplicativeDN
        );
        expect.fail(
          'No account should have been created when updating with no existing accounts'
        );
      } catch (err: any) {
        // NoSuchObjectError is expected - no account was created
        expect(err.message || err.code).to.match(/No such object|0x20/i);
      }
    });

    it('should update all app accounts when user mail changes', async function () {
      this.timeout(10000);

      // Create user with mail
      const userAttrs = {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'P@ssw0rd!123',
      };

      await dm.ldap.add(testUserDN, userAttrs);

      // Wait for principal account creation
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create app accounts (simulating API creation)
      const appAccount1DN = `uid=testuser_c12345678,${applicativeBase}`;
      const appAccount2DN = `uid=testuser_c87654321,${applicativeBase}`;

      await dm.ldap.add(appAccount1DN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser_c12345678',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'A1b2@-C3d4$-E5f6!-G7h8#-J9k0%-L1m2@',
        description: 'My Phone',
      });

      await dm.ldap.add(appAccount2DN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser_c87654321',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
        userPassword: 'M3n4!-P5q6@-R7s8#-T9u0$-V1w2%-X3y4@',
        description: 'My Laptop',
      });

      // Change user's mail
      await dm.ldap.modify(testUserDN, {
        replace: { mail: 'newemail@example.com' },
      });

      // Wait for all updates (hooks are async and need time to propagate)
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify principal account changed uid
      const newPrincipalDN = `uid=newemail@example.com,${applicativeBase}`;
      let result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        newPrincipalDN
      );
      expect((result as any).searchEntries).to.have.lengthOf(1);
      let entry = (result as any).searchEntries[0];
      expect(entry.uid).to.equal('newemail@example.com');
      expect(entry.mail).to.equal('newemail@example.com');

      // Verify app accounts kept their uid but changed mail
      result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        appAccount1DN
      );
      expect((result as any).searchEntries).to.have.lengthOf(1);
      entry = (result as any).searchEntries[0];
      expect(entry.uid).to.equal('testuser_c12345678'); // UID unchanged
      expect(entry.mail).to.equal('newemail@example.com'); // Mail updated
      expect(entry.description).to.equal('My Phone'); // Description preserved

      result = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        appAccount2DN
      );
      expect((result as any).searchEntries).to.have.lengthOf(1);
      entry = (result as any).searchEntries[0];
      expect(entry.uid).to.equal('testuser_c87654321'); // UID unchanged
      expect(entry.mail).to.equal('newemail@example.com'); // Mail updated
      expect(entry.description).to.equal('My Laptop'); // Description preserved

      // Cleanup - ignore errors if already deleted
      try {
        await dm.ldap.delete(newPrincipalDN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(appAccount1DN);
      } catch (err) {
        // Ignore
      }
      try {
        await dm.ldap.delete(appAccount2DN);
      } catch (err) {
        // Ignore
      }
    });
  });

  describe('Configuration', () => {
    it('should throw error if applicative_account_base is not configured', () => {
      const dmTest = new DM();
      dmTest.config.applicative_account_base = undefined;

      expect(() => new AppAccountsConsistency(dmTest)).to.throw(
        /applicative_account_base configuration is required/
      );
    });
  });
});
