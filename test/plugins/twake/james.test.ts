import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import { expect } from 'chai';
import OnLdapChange from '../../../src/plugins/ldap/onChange';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
  const testDNQuota = `uid=quotauser,${process.env.DM_LDAP_BASE}`;
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
      //.post(new RegExp('users/testmail@test.org/rename/t@t.org.*'))
      .persist()
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
      .reply(200, { success: true })
      .put('/quota/users/testmail@test.org/size', '50000000')
      .reply(204)
      .put('/quota/users/testmail@test.org/size', '100000000')
      .reply(204)
      .put('/quota/users/quotauser@test.org/size', '75000000')
      .reply(204);
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
      await dm.ldap.delete(testDNQuota);
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

  // Quota management tests require schema with mailQuota attribute
  // These can be enabled when testing with appropriate LDAP schema
  describe.skip('Quota management', () => {
    it('should initialize quota when user is created', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Quota User',
        sn: 'User',
        uid: 'quotauser',
        mail: 'quotauser@test.org',
        mailQuota: '75000000',
      };
      const res = await dm.ldap.add(testDNQuota, entry);
      expect(res).to.be.true;

      // Wait for ldapadddone hook to execute
      await new Promise(resolve => setTimeout(resolve, 1200));
    });

    it('should update quota when modified in LDAP', async () => {
      const entry = {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'Test User',
        sn: 'User',
        uid: 'testusermail',
        mail: 'testmail@test.org',
        mailQuota: '50000000',
      };
      let res = await dm.ldap.add(testDN, entry);
      expect(res).to.be.true;

      // Modify quota
      res = await dm.ldap.modify(testDN, {
        replace: { mailQuota: '100000000' },
      });
      expect(res).to.be.true;
    });
  });
});
