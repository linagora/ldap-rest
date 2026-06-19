import { expect } from 'chai';
import request from 'supertest';
import { DM } from '../../../src/bin';
import AppAccountsApi from '../../../src/plugins/twake/appAccountsApi';
import AppAccountsConsistency from '../../../src/plugins/twake/appAccountsConsistency';
import OnChange from '../../../src/plugins/ldap/onChange';
import AuthToken from '../../../src/plugins/auth/token';

describe('App Accounts API Plugin', function () {
  const timestamp = Date.now();
  const testUser = `testuser-${timestamp}`;
  // App-account endpoints key on the principal email (the `:user` path param),
  // not the LDAP uid.
  const principalEmail = `${testUser}@example.com`;
  // Generated app-account uids are prefixed from the (sanitized) `:user` value.
  const appUidPrefix = principalEmail.replace(/[^A-Za-z0-9_-]/g, '_');
  let applicativeBase: string;
  let userBase: string;
  let testUserDN: string;
  let testApplicativeDN: string;
  let dm: DM;
  let appAccountsApi: AppAccountsApi;
  const testToken = 'test-token-12345';

  beforeEach(async function () {
    this.timeout(10000);

    // The global test setup (test/setup.ts) provides an LDAP server — either an
    // external one (env vars set) or an embedded Docker one whose env vars are
    // exported in the root beforeAll hook. Skip only if neither is available.
    if (!process.env.DM_LDAP_BASE) {
      this.skip();
    }

    dm = new DM();
    dm.config.ldap_base = process.env.DM_LDAP_BASE;
    dm.config.auth_token = [testToken];
    await dm.ready;

    // Initialize bases
    userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
    applicativeBase = `ou=applicative,${process.env.DM_LDAP_BASE}`;

    testUserDN = `uid=${testUser},${userBase}`;
    testApplicativeDN = `uid=${testUser}@example.com,${applicativeBase}`;

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
          filter: `(uid=${testUser}_*)`,
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
        .get(`/api/v1/users/${principalEmail}/app-accounts`)
        .expect(401);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(dm.app)
        .get('/api/v1/users/nonexistent@example.com/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(404);

      expect(res.body.error).to.match(/not found/i);
    });

    it('should return empty array for user without app accounts', async () => {
      // Create user with mail
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });

      // Wait for principal account creation
      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request(dm.app)
        .get(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      expect(res.body).to.be.an('array');
      expect(res.body).to.have.lengthOf(0);
    });

    it('should list app accounts for user', async () => {
      // Create user
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });

      // Wait for principal account
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create app accounts via API
      const res1 = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Phone' })
        .expect(200);

      const res2 = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Laptop' })
        .expect(200);

      // List accounts
      const listRes = await request(dm.app)
        .get(`/api/v1/users/${principalEmail}/app-accounts`)
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
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .send({ name: 'Test' })
        .expect(401);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(dm.app)
        .post('/api/v1/users/nonexistent@example.com/app-accounts')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Test' })
        .expect(404);

      expect(res.body.error).to.match(/not found/i);
    });

    it('should create an app account with generated credentials', async () => {
      // Create user
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });

      // Wait for principal account
      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Device' })
        .expect(200);

      expect(res.body).to.have.property('uid');
      expect(res.body).to.have.property('pwd');
      expect(res.body).to.have.property('mail');
      expect(res.body.uid).to.match(new RegExp(`^${appUidPrefix}_c\\d{8}$`));
      expect(res.body.pwd).to.match(
        /^[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+-[\w!@#$%]+$/
      );
      expect(res.body.mail).to.equal(`${testUser}@example.com`);

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
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const res = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({})
        .expect(200);

      expect(res.body.uid).to.match(new RegExp(`^${appUidPrefix}_c\\d{8}$`));

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
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create 2 accounts (should succeed)
      await request(dmTest.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Device 1' })
        .expect(200);

      await request(dmTest.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Device 2' })
        .expect(200);

      // Third should fail
      const res = await request(dmTest.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Device 3' })
        .expect(400);

      expect(res.body.error).to.match(/Maximum number of accounts/i);
    });
  });

  describe('DELETE /api/v1/users/:user/app-accounts/:uid', () => {
    it('should return 401 without authorization', async () => {
      const res = await request(dm.app)
        .delete(
          `/api/v1/users/${principalEmail}/app-accounts/${testUser}_c12345678`
        )
        .expect(401);
    });

    it('should return 403 when the account belongs to a different principal', async () => {
      // Create the user and one app account owned by its principal mail
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      const createRes = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Device' })
        .expect(200);

      const uid = createRes.body.uid;

      // A different principal must not be able to delete it
      const res = await request(dm.app)
        .delete(`/api/v1/users/intruder@example.com/app-accounts/${uid}`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(403);

      expect(res.body.error).to.match(/does not belong/i);

      // ...and the account must still exist
      const survivor = await dm.ldap.search(
        { scope: 'base', paged: false },
        `uid=${uid},${applicativeBase}`
      );
      expect((survivor as any).searchEntries).to.have.lengthOf(1);
    });

    it('should delete an app account', async () => {
      // Create user
      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Create app account
      const createRes = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
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
        .delete(`/api/v1/users/${principalEmail}/app-accounts/${uid}`)
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
        .delete(
          `/api/v1/users/${principalEmail}/app-accounts/${testUser}_c99999999`
        )
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      expect(res.body.uid).to.equal(`${testUser}_c99999999`);
    });

    // Regression test for issue #84: deleting ONE app account must not cascade
    // into deleting the user's other app accounts (or the principal entry).
    it('should NOT cascade-delete the other app accounts (issue #84)', async function () {
      this.timeout(15000);

      await dm.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });
      // Let the consistency plugin create the principal applicative account
      await new Promise(resolve => setTimeout(resolve, 300));

      // Create two app accounts through the real API
      const created1 = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Phone' })
        .expect(200);
      const created2 = await request(dm.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Laptop' })
        .expect(200);

      const uid1 = created1.body.uid as string;
      const uid2 = created2.body.uid as string;

      // Delete ONLY the first one
      await request(dm.app)
        .delete(`/api/v1/users/${principalEmail}/app-accounts/${uid1}`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      // Give the async onLdapMailChange hook time to (wrongly) cascade
      await new Promise(resolve => setTimeout(resolve, 500));

      // The deleted account is gone...
      try {
        await dm.ldap.search(
          { scope: 'base', paged: false },
          `uid=${uid1},${applicativeBase}`
        );
        expect.fail(`${uid1} should have been deleted`);
      } catch (err: any) {
        expect(err.message || err.code).to.match(/No such object|0x20/i);
      }

      // ...but the second app account and the principal entry MUST survive.
      const survivor = await dm.ldap.search(
        { scope: 'base', paged: false },
        `uid=${uid2},${applicativeBase}`
      );
      expect(
        (survivor as any).searchEntries,
        `${uid2} must survive a single-account delete (no cascade)`
      ).to.have.lengthOf(1);

      const principal = await dm.ldap.search(
        { scope: 'base', paged: false },
        `uid=${testUser}@example.com,${applicativeBase}`
      );
      expect(
        (principal as any).searchEntries,
        'principal applicative account must survive a single-account delete'
      ).to.have.lengthOf(1);
    });
  });

  // Regression: two users sharing the SAME uid under different subtrees, with
  // distinct mails. App-account operations key on the unique mail, so they must
  // resolve to the matching principal and never cross-contaminate.
  describe('uid collisions across subtrees (regression)', () => {
    const sharedUid = `collide-${timestamp}`;
    const mailA = `${sharedUid}-a@example.com`;
    const mailB = `${sharedUid}-b@example.com`;
    let ouA: string;
    let ouB: string;
    let dnA: string;
    let dnB: string;

    beforeEach(async function () {
      if (!process.env.DM_LDAP_BASE) this.skip();

      ouA = `ou=orga-${timestamp},${process.env.DM_LDAP_BASE}`;
      ouB = `ou=orgb-${timestamp},${process.env.DM_LDAP_BASE}`;
      dnA = `uid=${sharedUid},${ouA}`;
      dnB = `uid=${sharedUid},${ouB}`;

      for (const ou of [ouA, ouB]) {
        try {
          await dm.ldap.add(ou, {
            objectClass: ['organizationalUnit', 'top'],
            ou: ou.split(',')[0].replace('ou=', ''),
          });
        } catch (err) {
          // Ignore if already exists
        }
      }

      await dm.ldap.add(dnA, {
        objectClass: 'inetOrgPerson',
        uid: sharedUid,
        cn: 'Collide A',
        sn: 'A',
        mail: mailA,
      });
      await dm.ldap.add(dnB, {
        objectClass: 'inetOrgPerson',
        uid: sharedUid,
        cn: 'Collide B',
        sn: 'B',
        mail: mailB,
      });

      // Let the consistency plugin create both principal accounts
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    afterEach(async () => {
      try {
        const result = await dm.ldap.search(
          {
            scope: 'sub',
            filter: `(|(mail=${mailA})(mail=${mailB})(uid=${sharedUid}_*))`,
            paged: false,
          },
          applicativeBase
        );
        for (const entry of (result as any).searchEntries || []) {
          try {
            await dm.ldap.delete(entry.dn);
          } catch (e) {
            // Ignore
          }
        }
      } catch (e) {
        // Ignore
      }
      for (const dn of [dnA, dnB, ouA, ouB]) {
        try {
          await dm.ldap.delete(dn);
        } catch (e) {
          // Ignore
        }
      }
    });

    it('attaches each app account to the matching principal, not the same-uid user', async () => {
      const a = await request(dm.app)
        .post(`/api/v1/users/${mailA}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'A device' })
        .expect(200);

      const b = await request(dm.app)
        .post(`/api/v1/users/${mailB}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'B device' })
        .expect(200);

      // Each app account belongs to its own principal mail
      expect(a.body.mail).to.equal(mailA);
      expect(b.body.mail).to.equal(mailB);

      // Listing by one mail never surfaces the other principal's account
      const listA = await request(dm.app)
        .get(`/api/v1/users/${mailA}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
      const uidsA = listA.body.map((acc: any) => acc.uid);
      expect(uidsA).to.include(a.body.uid);
      expect(uidsA).to.not.include(b.body.uid);

      const listB = await request(dm.app)
        .get(`/api/v1/users/${mailB}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
      const uidsB = listB.body.map((acc: any) => acc.uid);
      expect(uidsB).to.include(b.body.uid);
      expect(uidsB).to.not.include(a.body.uid);

      // The same-uid principal cannot delete the other's account
      await request(dm.app)
        .delete(`/api/v1/users/${mailA}/app-accounts/${b.body.uid}`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(403);
    });
  });

  // Legacy opt-in: app_accounts_user_attribute='uid' restores the pre-#89
  // contract where `:user` is the LDAP uid and app-uids stay `<uid>_c<digits>`.
  describe('legacy uid key mode (app_accounts_user_attribute=uid)', () => {
    let dmUid: DM;

    beforeEach(async function () {
      this.timeout(10000);
      if (!process.env.DM_LDAP_BASE) this.skip();

      dmUid = new DM();
      dmUid.config.ldap_base = process.env.DM_LDAP_BASE;
      dmUid.config.auth_token = [testToken];
      dmUid.config.applicative_account_base = applicativeBase;
      dmUid.config.mail_attribute = 'mail';
      dmUid.config.app_accounts_user_attribute = 'uid';
      await dmUid.ready;

      await dmUid.registerPlugin('authToken', new AuthToken(dmUid));
      await dmUid.registerPlugin('onLdapChange', new OnChange(dmUid));
      await dmUid.registerPlugin(
        'appAccountsConsistency',
        new AppAccountsConsistency(dmUid)
      );
      await dmUid.registerPlugin('appAccountsApi', new AppAccountsApi(dmUid));

      await dmUid.ldap.add(testUserDN, {
        objectClass: 'inetOrgPerson',
        uid: testUser,
        cn: 'Test User',
        sn: 'User',
        mail: `${testUser}@example.com`,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    it('resolves :user by uid and keeps the <uid>_c<digits> format', async () => {
      // The mail is NOT accepted as :user in uid mode.
      await request(dmUid.app)
        .post(`/api/v1/users/${principalEmail}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'Mail device' })
        .expect(404);

      // The uid is.
      const created = await request(dmUid.app)
        .post(`/api/v1/users/${testUser}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .send({ name: 'My Device' })
        .expect(200);
      expect(created.body.uid).to.match(new RegExp(`^${testUser}_c\\d{8}$`));
      expect(created.body.mail).to.equal(`${testUser}@example.com`);

      // Listing and deleting work through the uid as well.
      const list = await request(dmUid.app)
        .get(`/api/v1/users/${testUser}/app-accounts`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
      expect(list.body.map((a: any) => a.uid)).to.include(created.body.uid);

      await request(dmUid.app)
        .delete(`/api/v1/users/${testUser}/app-accounts/${created.body.uid}`)
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);
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
