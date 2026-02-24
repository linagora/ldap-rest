import nock from 'nock';

import { DM } from '../../../src/bin';
import Drive from '../../../src/plugins/twake/drive';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

// Default Drive webadmin URL for tests (using nock for mocking)
const TWAKE_DRIVE_WEBADMIN_URL = 'http://localhost:6060';

describe('Drive Plugin', () => {
  let testDN: string;
  let testDNDisplayName: string;
  let dm: DM;
  let drive: Drive;
  let scope: nock.Scope;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    // Set default Drive webadmin URL for tests if not set
    if (!process.env.DM_TWAKE_DRIVE_WEBADMIN_URL) {
      process.env.DM_TWAKE_DRIVE_WEBADMIN_URL = TWAKE_DRIVE_WEBADMIN_URL;
    }

    // Initialize DNs after env vars are set
    testDN = `uid=testdriveuser,${process.env.DM_LDAP_BASE}`;
    testDNDisplayName = `uid=drivedisplayuser,${process.env.DM_LDAP_BASE}`;

    scope = nock(
      process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
    ).persist();

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
    await dm.ready;
    drive = new Drive(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('drive', drive);
  });

  afterEach(async () => {
    // Clean up: delete the test entries if they exist
    try {
      await dm.ldap.delete(testDN);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
    try {
      await dm.ldap.delete(testDNDisplayName);
    } catch (err) {
      // Ignore errors if the entry does not exist
    }
  });

  describe('Mail change propagation', () => {
    it('should update Cozy instance when mail changes', async () => {
      let apiCalled = false;
      const mailChangeScope = nock(
        process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
      )
        .patch('/instances/testuser.mycozy.cloud')
        .query({
          FromCloudery: 'true',
          Email: 'newmail@test.org',
        })
        .reply(200, { success: true });

      mailChangeScope.on('request', () => {
        apiCalled = true;
      });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Test User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'oldmail@test.org',
        twakeCozyDomain: 'testuser.mycozy.cloud',
      };
      let res = await dm.ldap.add(testDN, entry);
      expect(res).to.be.true;

      // Modify mail
      res = await dm.ldap.modify(testDN, {
        replace: { mail: 'newmail@test.org' },
      });
      expect(res).to.be.true;

      // Wait for onChange hook to execute
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(apiCalled).to.be.true;
    });

    it('should skip mail change when user has no Cozy domain', async () => {
      let apiCalled = false;
      const noCozyScope = nock(
        process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
      )
        .patch(/\/instances\/.*/)
        .reply(200, { success: true });

      noCozyScope.on('request', () => {
        apiCalled = true;
      });

      // Create user without twakeCozyDomain
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Test User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'oldmail@test.org',
      };
      let res = await dm.ldap.add(testDN, entry);
      expect(res).to.be.true;

      // Modify mail
      res = await dm.ldap.modify(testDN, {
        replace: { mail: 'newmail@test.org' },
      });
      expect(res).to.be.true;

      // Wait for onChange hook to execute
      await new Promise(resolve => setTimeout(resolve, 150));

      // API should NOT be called
      expect(apiCalled).to.be.false;
    });

    it('should handle 404 response gracefully (instance not provisioned)', async () => {
      const notFoundScope = nock(
        process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
      )
        .patch('/instances/notfound.mycozy.cloud')
        .query({
          FromCloudery: 'true',
          Email: 'new@test.org',
        })
        .reply(404, { error: 'Instance not found' });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Test User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'old@test.org',
        twakeCozyDomain: 'notfound.mycozy.cloud',
      };
      let res = await dm.ldap.add(testDN, entry);
      expect(res).to.be.true;

      // Modify mail - should not throw
      res = await dm.ldap.modify(testDN, {
        replace: { mail: 'new@test.org' },
      });
      expect(res).to.be.true;

      // Wait for onChange hook to execute
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(notFoundScope.isDone()).to.be.true;
    });
  });

  describe('Display name change propagation', () => {
    // Note: onLdapDisplayNameChange is triggered when cn, givenName, or sn changes,
    // not when displayName changes directly. Test with cn change instead.
    it('should update Cozy instance when cn changes', async () => {
      let callCount = 0;
      let lastPublicName = '';

      // Mock that accepts any PublicName and tracks calls
      nock(process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL)
        .patch('/instances/cnuser2.mycozy.cloud')
        .query((query: Record<string, string>) => {
          return query.FromCloudery === 'true' && !!query.PublicName;
        })
        .times(2) // Allow up to 2 calls (creation + modification)
        .reply(200, function (uri) {
          callCount++;
          const url = new URL(uri, 'http://localhost');
          lastPublicName = url.searchParams.get('PublicName') || '';
          return { success: true };
        });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Old CN Name',
        sn: 'User',
        uid: 'drivedisplayuser',
        mail: 'cn2@test.org',
        twakeCozyDomain: 'cnuser2.mycozy.cloud',
      };
      let res = await dm.ldap.add(testDNDisplayName, entry);
      expect(res).to.be.true;

      // Wait for ldapadddone hook to potentially execute
      await new Promise(resolve => setTimeout(resolve, 100));

      // Modify cn - this triggers onLdapDisplayNameChange
      res = await dm.ldap.modify(testDNDisplayName, {
        replace: { cn: 'New CN Name' },
      });
      expect(res).to.be.true;

      // Wait for onChange hook to execute
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify API was called at least once with the new name
      expect(callCount).to.be.greaterThan(0);
      expect(lastPublicName).to.equal('New CN Name');
    });

    it('should update Cozy instance when cn changes (fallback)', async () => {
      let apiCalled = false;
      const cnScope = nock(
        process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
      )
        .patch('/instances/cnuser.mycozy.cloud')
        .query({
          FromCloudery: 'true',
          PublicName: 'New CN Name',
        })
        .reply(200, { success: true });

      cnScope.on('request', () => {
        apiCalled = true;
      });

      // Create user without displayName (uses cn as fallback)
      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Old CN Name',
        sn: 'User',
        uid: 'drivedisplayuser',
        mail: 'cn@test.org',
        twakeCozyDomain: 'cnuser.mycozy.cloud',
      };
      let res = await dm.ldap.add(testDNDisplayName, entry);
      expect(res).to.be.true;

      // Modify cn
      res = await dm.ldap.modify(testDNDisplayName, {
        replace: { cn: 'New CN Name' },
      });
      expect(res).to.be.true;

      // Wait for onChange hook to execute
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(apiCalled).to.be.true;
    });

    it('should skip display name change when user has no Cozy domain', async () => {
      let apiCalled = false;
      const noCozyScope = nock(
        process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
      )
        .patch(/\/instances\/.*/)
        .reply(200, { success: true });

      noCozyScope.on('request', () => {
        apiCalled = true;
      });

      // Create user without twakeCozyDomain
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'No Cozy User',
        sn: 'User',
        uid: 'drivedisplayuser',
        mail: 'nocozy@test.org',
        displayName: 'Old Name',
      };
      let res = await dm.ldap.add(testDNDisplayName, entry);
      expect(res).to.be.true;

      // Modify displayName
      res = await dm.ldap.modify(testDNDisplayName, {
        replace: { displayName: 'New Name' },
      });
      expect(res).to.be.true;

      // Wait for onChange hook to execute
      await new Promise(resolve => setTimeout(resolve, 150));

      // API should NOT be called
      expect(apiCalled).to.be.false;
    });
  });

  describe('Public methods', () => {
    it('getCozyDomain should return the Cozy domain attribute', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Cozy User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'cozy@test.org',
        twakeCozyDomain: 'cozyuser.mycozy.cloud',
      };
      await dm.ldap.add(testDN, entry);

      const domain = await drive.getCozyDomain(testDN);
      expect(domain).to.equal('cozyuser.mycozy.cloud');
    });

    it('getCozyDomain should return null if attribute is missing', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'No Cozy User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'nocozy@test.org',
      };
      await dm.ldap.add(testDN, entry);

      const domain = await drive.getCozyDomain(testDN);
      expect(domain).to.be.null;
    });

    it('getDisplayNameFromDN should return display name with fallback', async () => {
      // Test with displayName
      const entry1 = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'CN Name',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'test@test.org',
        displayName: 'Display Name',
      };
      await dm.ldap.add(testDN, entry1);

      let name = await drive.getDisplayNameFromDN(testDN);
      expect(name).to.equal('Display Name');

      await dm.ldap.delete(testDN);

      // Test with cn fallback (no displayName)
      const entry2 = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'CN Name',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'test@test.org',
      };
      await dm.ldap.add(testDN, entry2);

      name = await drive.getDisplayNameFromDN(testDN);
      expect(name).to.equal('CN Name');

      await dm.ldap.delete(testDN);

      // Test with givenName + sn fallback (cn present but displayName not)
      const entry3 = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Placeholder',
        sn: 'Doe',
        givenName: 'John',
        uid: 'testdriveuser',
        mail: 'test@test.org',
      };
      await dm.ldap.add(testDN, entry3);

      // Since cn is present, it will be used as fallback (displayName -> cn -> givenName+sn)
      name = await drive.getDisplayNameFromDN(testDN);
      expect(name).to.equal('Placeholder');
    });

    it('getMailFromDN should return the mail attribute', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Mail User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'mailuser@test.org',
      };
      await dm.ldap.add(testDN, entry);

      const mail = await drive.getMailFromDN(testDN);
      expect(mail).to.equal('mailuser@test.org');
    });

    it('syncUserToCozy should manually sync user attributes', async () => {
      let apiCalled = false;
      const syncScope = nock(
        process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL
      )
        .patch('/instances/syncuser.mycozy.cloud')
        .query({
          FromCloudery: 'true',
          Email: 'sync@test.org',
          PublicName: 'Sync User',
        })
        .reply(200, { success: true });

      syncScope.on('request', () => {
        apiCalled = true;
      });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Sync User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'sync@test.org',
        twakeCozyDomain: 'syncuser.mycozy.cloud',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.syncUserToCozy(testDN);
      expect(result).to.be.true;
      expect(apiCalled).to.be.true;
    });

    it('syncUserToCozy should return false if user has no Cozy domain', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'No Cozy',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'nocozy@test.org',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.syncUserToCozy(testDN);
      expect(result).to.be.false;
    });

    it('syncUserToCozy should return false if user not found', async () => {
      const result = await drive.syncUserToCozy(
        `uid=nonexistent,${process.env.DM_LDAP_BASE}`
      );
      expect(result).to.be.false;
    });

    it('blockInstance should block a Cozy instance', async () => {
      let apiCalled = false;
      let blockedValue = '';
      let reasonValue = '';

      nock(process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL)
        .patch('/instances/blockuser.mycozy.cloud')
        .query((query: Record<string, string>) => {
          blockedValue = query.Blocked;
          reasonValue = query.BlockingReason || '';
          return query.FromCloudery === 'true' && query.Blocked === 'true';
        })
        .reply(200, function () {
          apiCalled = true;
          return { success: true };
        });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Block User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'block@test.org',
        twakeCozyDomain: 'blockuser.mycozy.cloud',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.blockInstance(testDN, 'PAYMENT_FAILED');
      expect(result).to.be.true;
      expect(apiCalled).to.be.true;
      expect(blockedValue).to.equal('true');
      expect(reasonValue).to.equal('PAYMENT_FAILED');
    });

    it('blockInstance should work without reason', async () => {
      let apiCalled = false;

      nock(process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL)
        .patch('/instances/blockuser2.mycozy.cloud')
        .query((query: Record<string, string>) => {
          return (
            query.FromCloudery === 'true' &&
            query.Blocked === 'true' &&
            !query.BlockingReason
          );
        })
        .reply(200, function () {
          apiCalled = true;
          return { success: true };
        });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Block User 2',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'block2@test.org',
        twakeCozyDomain: 'blockuser2.mycozy.cloud',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.blockInstance(testDN);
      expect(result).to.be.true;
      expect(apiCalled).to.be.true;
    });

    it('blockInstance should return false if user has no Cozy domain', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'No Cozy',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'nocozy@test.org',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.blockInstance(testDN);
      expect(result).to.be.false;
    });

    it('unblockInstance should unblock a Cozy instance', async () => {
      let apiCalled = false;
      let blockedValue = '';

      nock(process.env.DM_TWAKE_DRIVE_WEBADMIN_URL || TWAKE_DRIVE_WEBADMIN_URL)
        .patch('/instances/unblockuser.mycozy.cloud')
        .query((query: Record<string, string>) => {
          blockedValue = query.Blocked;
          return query.FromCloudery === 'true' && query.Blocked === 'false';
        })
        .reply(200, function () {
          apiCalled = true;
          return { success: true };
        });

      const entry = {
        objectClass: ['top', 'inetOrgPerson', 'twakeWhitePages'],
        cn: 'Unblock User',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'unblock@test.org',
        twakeCozyDomain: 'unblockuser.mycozy.cloud',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.unblockInstance(testDN);
      expect(result).to.be.true;
      expect(apiCalled).to.be.true;
      expect(blockedValue).to.equal('false');
    });

    it('unblockInstance should return false if user has no Cozy domain', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'No Cozy',
        sn: 'User',
        uid: 'testdriveuser',
        mail: 'nocozy@test.org',
      };
      await dm.ldap.add(testDN, entry);

      const result = await drive.unblockInstance(testDN);
      expect(result).to.be.false;
    });
  });
});
