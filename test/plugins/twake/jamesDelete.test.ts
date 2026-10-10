import { expect } from 'chai';
import nock from 'nock';
import type { Entry } from 'ldapts';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

/**
 * Deleting a user leaves its James data alone: James purges it later.
 */
describe('James Plugin - user deletion', () => {
  const url = 'http://james.delete.test:8000';
  let dm: DM;
  let dn: string;
  let calls: string[];
  let deleted: string[];

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    dn = `uid=jamesdeleted,${process.env.DM_LDAP_BASE}`;
    nock.disableNetConnect();
    const scope = nock(url).persist();
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
      scope
        .intercept(() => true, method)
        .reply(function (uri) {
          calls.push(`${method} ${uri}`);
          return method === 'GET' ? [200, []] : [204, ''];
        });

    dm = new DM();
    dm.config.james_webadmin_url = url;
    dm.config.james_init_delay = 0;
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    await dm.ready;
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', new LdapGroups(dm));
    await dm.registerPlugin('james', new James(dm));
    dm.hooks.onLdapEntryChange = [
      ...(dm.hooks.onLdapEntryChange || []),
      (d: string, _before: Entry | null, after: Entry | null) => {
        if (after === null) deleted.push(d);
      },
    ];
  });

  after(async () => {
    await dm?.ldap.delete(dn).catch(() => undefined);
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('makes no James call, and no call about a "null" address', async () => {
    calls = [];
    deleted = [];
    await dm.ldap.add(dn, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: 'jamesdeleted',
      cn: 'James Deleted',
      displayName: 'James Deleted',
      mail: 'jamesdeleted@test.org',
      mailQuotaSize: '1000',
      mailAlternateAddress: 'jd-alias@test.org',
      mailForwardingAddress: 'jd-forward@test.org',
    });
    // The add's calls: quota, alias, forward and the identity, once from
    // ldapadddone and once from the display name hook
    await waitFor(
      () => calls.filter(c => c.includes('/identities')).length >= 4,
      { what: 'the calls of the add' }
    );
    // Let anything still running from the add finish before counting
    await new Promise(resolve => setTimeout(resolve, 200));
    calls = [];

    await dm.ldap.delete(dn);
    await waitFor(() => deleted.includes(dn), { what: 'the delete' });
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(calls).to.eql([]);
  });
});
