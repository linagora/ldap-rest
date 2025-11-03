import { expect } from 'chai';
import request from 'supertest';
import { DM } from '../../../src/bin';
import AppAccountsApi from '../../../src/plugins/twake/appAccountsApi';
import AppAccountsConsistency from '../../../src/plugins/twake/appAccountsConsistency';
import OnChange from '../../../src/plugins/ldap/onChange';
import AuthToken from '../../../src/plugins/auth/token';

describe('App Accounts API Plugin', function () {
  // Skip all tests if required env vars are not set
  if (
    !process.env.DM_LDAP_DN ||
    !process.env.DM_LDAP_PWD ||
    !process.env.DM_LDAP_BASE
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Skipping App Accounts API tests: DM_LDAP_DN or DM_LDAP_PWD or DM_LDAP_BASE not set'
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
  let appAccountsApi: AppAccountsApi;
  const testToken = 'test-token-12345';

  beforeEach(async function () {
    this.timeout(10000);

    dm = new DM();
    dm.config.ldap_base = process.env.DM_LDAP_BASE;
    dm.config.auth_token = [testToken];
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
    dm.config.max_app_accounts = 5;

    // Register auth plugin
    const authToken = new AuthToken(dm);
    await dm.registerPlugin('authToken', authToken);

    // Register onChange plugin (dependency)
    const onChange = new OnChange(dm);
    await dm.registerPlugin('onLdapChange', onChange);

    // Register appAccountsConsistency plugin
    const appAccountsConsistency = new AppAccountsConsistency(dm);
    await dm.registerPlugin('appAccountsConsistency', appAccountsConsistency);

    // Register API plugin
    appAccountsApi = new AppAccountsApi(dm);
    await dm.registerPlugin('appAccountsApi', appAccountsApi);
  });

  afterEach(async () => {
    // Clean up test data - delete all possible test entries
    const testDNs = [testUserDN, testApplicativeDN];

    // Also clean up any created app accounts
    try {
      const result = await dm.ldap.search(
        {
          scope: 'sub',
          filter: '(uid=testuser_*)',
          paged: false,
        },
        applicativeBase
      );
      const entries = (result as any).searchEntries || [];
      for (const entry of entries) {
        testDNs.push(entry.dn);
      }
    } catch (err) {
      // Ignore
    }

    for (const dn of testDNs) {
      try {
        await dm.ldap.delete(dn);
      } catch (err) {
        // Ignore if doesn't exist
      }
    }
  });

  describe('GET /api/v1/users/:user/app-accounts', () => {
    it('should return 401 without authorization', async () => {
      const res = await request(dm.app)
        .get('/api/v1/users/testuser/app-accounts')
        .expect(401);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(dm.app)
        .get('/api/v1/users/nonexistent/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(404);

      expect(res.body.error).to.match(/not found/i);
    });

    it('should return empty array for user without app accounts', async () => {
      // Create user with mail
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      });

      // Wait for principal account creation
      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request(dm.app)
        .get('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      expect(res.body).to.be.an('array');
      expect(res.body).to.have.lengthOf(0);
    });

    it('should list app accounts for user', async () => {
      // Create user
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      });

      // Wait for principal account
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create app accounts via API
      const res1 = await request(dm.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Phone' })
        .expect(200);

      const res2 = await request(dm.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Laptop' })
        .expect(200);

      // List accounts
      const listRes = await request(dm.app)
        .get('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      expect(listRes.body).to.be.an('array');
      expect(listRes.body).to.have.lengthOf(2);

      // Check accounts are in the list (order may vary)
      const uids = listRes.body.map((acc: any) => acc.uid);
      expect(uids).to.include(res1.body.uid);
      expect(uids).to.include(res2.body.uid);

      // Check names match
      const acc1 = listRes.body.find((a: any) => a.uid === res1.body.uid);
      const acc2 = listRes.body.find((a: any) => a.uid === res2.body.uid);
      expect(acc1.name).to.equal('My Phone');
      expect(acc2.name).to.equal('My Laptop');
    });
  });

  describe('POST /api/v1/users/:user/app-accounts', () => {
    it('should return 401 without authorization', async () => {
      const res = await request(dm.app)
        .post('/api/v1/users/testuser/app-accounts')
        .send({ name: 'Test' })
        .expect(401);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(dm.app)
        .post('/api/v1/users/nonexistent/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Test' })
        .expect(404);

      expect(res.body.error).to.match(/not found/i);
    });

    it('should create an app account with generated credentials', async () => {
      // Create user
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      });

      // Wait for principal account
      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request(dm.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Device' })
        .expect(200);

      expect(res.body).to.have.property('uid');
      expect(res.body).to.have.property('pwd');
      expect(res.body).to.have.property('mail');
      expect(res.body.uid).to.match(/^testuser_c\d{8}$/);
      expect(res.body.pwd).to.match(
        /^[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+$/
      );
      expect(res.body.mail).to.equal('testuser@example.com');

      // Verify account was created in LDAP
      const searchRes = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        `uid=${res.body.uid},${applicativeBase}`
      );

      const entry = (searchRes as any).searchEntries[0];
      expect(entry).to.exist;
      expect(entry.description).to.equal('My Device');
    });

    it('should create account without description if not provided', async () => {
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request(dm.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({})
        .expect(200);

      expect(res.body.uid).to.match(/^testuser_c\d{8}$/);

      // Verify no description attribute
      const searchRes = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        `uid=${res.body.uid},${applicativeBase}`
      );

      const entry = (searchRes as any).searchEntries[0];
      expect(entry.description).to.be.undefined;
    });

    it('should enforce max accounts limit', async function () {
      this.timeout(10000);

      // Create a new DM instance with max=2 for this test
      const dmTest = new DM();
      dmTest.config.ldap_base = process.env.DM_LDAP_BASE;
      dmTest.config.auth_token = [testToken];
      dmTest.config.applicative_account_base = applicativeBase;
      dmTest.config.mail_attribute = 'mail';
      dmTest.config.max_app_accounts = 2; // Set limit to 2
      await dmTest.ready;

      // Register plugins
      const authToken = new AuthToken(dmTest);
      await dmTest.registerPlugin('authToken', authToken);

      const onChange = new OnChange(dmTest);
      await dmTest.registerPlugin('onLdapChange', onChange);

      const appAccountsConsistency = new AppAccountsConsistency(dmTest);
      await dmTest.registerPlugin(
        'appAccountsConsistency',
        appAccountsConsistency
      );

      const testAppAccountsApi = new AppAccountsApi(dmTest);
      await dmTest.registerPlugin('appAccountsApi', testAppAccountsApi);

      // Create user
      await dmTest.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create 2 accounts (should succeed)
      await request(dmTest.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Device 1' })
        .expect(200);

      await request(dmTest.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Device 2' })
        .expect(200);

      // Third should fail
      const res = await request(dmTest.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Device 3' })
        .expect(400);

      expect(res.body.error).to.match(/Maximum number of accounts/i);
    });
  });

  describe('DELETE /api/v1/users/:user/app-accounts/:uid', () => {
    it('should return 401 without authorization', async () => {
      const res = await request(dm.app)
        .delete('/api/v1/users/testuser/app-accounts/testuser_c12345678')
        .expect(401);
    });

    it('should return 403 if uid does not belong to user', async () => {
      const res = await request(dm.app)
        .delete('/api/v1/users/testuser/app-accounts/otheruser_c12345678')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(403);

      expect(res.body.error).to.match(/does not belong/i);
    });

    it('should delete an app account', async () => {
      // Create user
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: 'testuser',
        cn: 'Test User',
        sn: 'User',
        mail: 'testuser@example.com',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create app account
      const createRes = await request(dm.app)
        .post('/api/v1/users/testuser/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Device' })
        .expect(200);

      const uid = createRes.body.uid;

      // Verify account exists
      let searchRes = await dm.ldap.search(
        {
          scope: 'base',
          paged: false,
        },
        `uid=${uid},${applicativeBase}`
      );
      expect((searchRes as any).searchEntries).to.have.lengthOf(1);

      // Delete account
      const deleteRes = await request(dm.app)
        .delete(`/api/v1/users/testuser/app-accounts/${uid}`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      expect(deleteRes.body.uid).to.equal(uid);

      // Verify account was deleted
      try {
        await dm.ldap.search(
          {
            scope: 'base',
            paged: false,
          },
          `uid=${uid},${applicativeBase}`
        );
        expect.fail('Account should have been deleted');
      } catch (err: any) {
        expect(err.message || err.code).to.match(/No such object|0x20/i);
      }
    });

    it('should be idempotent (deleting non-existent account succeeds)', async () => {
      const res = await request(dm.app)
        .delete('/api/v1/users/testuser/app-accounts/testuser_c99999999')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      expect(res.body.uid).to.equal('testuser_c99999999');
    });
  });

  describe('Configuration', () => {
    it('should throw error if applicative_account_base is not configured', () => {
      const dmTest = new DM();
      dmTest.config.applicative_account_base = undefined;

      expect(() => new AppAccountsApi(dmTest)).to.throw(
        /applicative_account_base configuration is required/
      );
    });
  });
});
