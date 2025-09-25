import nock from 'nock';

import { DM } from '../../src/bin';
import James from '../../src/plugins/james';
import { expect } from 'chai';
import OnLdapChange from '../../src/plugins/onLdapChange';

describe('James Plugin', () => {
  const testDN = `uid=testusermail,${process.env.DM_LDAP_BASE}`;
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
      // @ts-ignore
      this.skip();
    }
    scope = nock(process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000')
      //.post(new RegExp('users/testmail@test.org/rename/t@t.org.*'))
      .persist()
      .post('/users/testmail@test.org/rename/t@t.org?action=rename')
      .reply(200, { success: true });
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
});
