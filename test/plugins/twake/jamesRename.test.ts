import { expect } from 'chai';
import nock from 'nock';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

/**
 * James's rename leaves the identities under the old address, and a forward
 * from the old address to the new one that outlives the account.
 */
describe('James Plugin - rename leftovers', () => {
  const url = 'http://james.rename.test:8000';
  let dm: DM;
  let dn: string;
  let calls: { call: string; body: unknown }[];
  // What James holds, by path, for the GETs
  let james: Record<string, [number, unknown]>;

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
    dn = `uid=jamesrenamed,${process.env.DM_LDAP_BASE}`;
    nock.disableNetConnect();
    const scope = nock(url).persist();
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
      scope
        .intercept(() => true, method)
        .reply(function (uri, body) {
          calls.push({ call: `${method} ${uri}`, body });
          if (method !== 'GET') return [204, ''];
          return james[uri] ?? [404, { statusCode: 404 }];
        });

    dm = new DM();
    dm.config.james_webadmin_url = url;
    dm.config.james_init_delay = 0;
    dm.config.james_retry_attempts = 1;
    dm.config.james_signature_template = '';
    await dm.ready;
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', new LdapGroups(dm));
    await dm.registerPlugin('james', new James(dm));
  });

  beforeEach(async () => {
    await dm?.ldap.delete(dn).catch(() => undefined);
    calls = [];
    james = {};
  });

  after(async () => {
    await dm?.ldap.delete(dn).catch(() => undefined);
    nock.cleanAll();
    nock.enableNetConnect();
  });

  const entry = {
    objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
    uid: 'jamesrenamed',
    cn: 'Jane Renamed',
    displayName: 'Jane Renamed',
    mail: 'jr-old@test.org',
    mailForwardingAddress: 'jr-own@test.org',
  };
  const seen = (call: string) => calls.findIndex(c => c.call === call);

  it('gives the renamed account its identity back, with its signatures', async () => {
    await dm.ldap.add(dn, entry);
    await waitFor(
      () => calls.filter(c => c.call.startsWith('POST /users/')).length >= 1,
      { what: 'the identity of the add' }
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    calls = [];
    james['/users/jr-old@test.org/identities?default=true'] = [
      200,
      [
        {
          id: 'old-id',
          name: 'Jane Renamed',
          email: 'jr-old@test.org',
          mayDelete: true,
          sortOrder: 0,
          htmlSignature: '<p>Jane</p>',
          textSignature: 'Jane',
        },
      ],
    ];

    await dm.ldap.modify(dn, { replace: { mail: 'jr-new@test.org' } });
    await waitFor(() => seen('POST /users/jr-new@test.org/identities') >= 0, {
      what: 'the identity of the new address',
    });

    expect(
      seen(
        'POST /users/jr-old@test.org/rename/jr-new@test.org?action=rename&force'
      )
    ).to.be.at.least(0);
    expect(
      calls[seen('POST /users/jr-new@test.org/identities')].body
    ).to.deep.equal({
      email: 'jr-new@test.org',
      name: 'Jane Renamed',
      sortOrder: 0,
      htmlSignature: '<p>Jane</p>',
      textSignature: 'Jane',
    });
  });

  it('drops the forwards a former owner left on the address an account takes', async () => {
    await dm.ldap.add(dn, entry);
    await waitFor(
      () => calls.filter(c => c.call.startsWith('POST /users/')).length >= 1,
      { what: 'the identity of the add' }
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    calls = [];
    james['/address/forwards/jr-new@test.org'] = [
      200,
      [
        { mailAddress: 'someone-else@test.org' },
        { mailAddress: 'JR-own@test.org' },
      ],
    ];

    await dm.ldap.modify(dn, { replace: { mail: 'jr-new@test.org' } });
    await waitFor(() => seen('POST /users/jr-new@test.org/identities') >= 0, {
      what: 'the end of the rename',
    });

    const dropped = calls
      .map(c => c.call)
      .filter(c => c.startsWith('DELETE /address/forwards/'));
    expect(dropped).to.deep.equal([
      'DELETE /address/forwards/jr-new@test.org/targets/someone-else@test.org',
    ]);
  });

  it('drops them on an add, and on an alias before it is added', async () => {
    james['/address/forwards/jr-old@test.org'] = [
      200,
      [{ mailAddress: 'gone@test.org' }, { mailAddress: 'jr-own@test.org' }],
    ];
    james['/address/forwards/jr-alias@test.org'] = [
      200,
      [{ mailAddress: 'gone@test.org' }],
    ];
    await dm.ldap.add(dn, {
      ...entry,
      mailAlternateAddress: 'jr-alias@test.org',
    });
    await waitFor(
      () =>
        seen(
          'PUT /address/aliases/jr-old@test.org/sources/jr-alias@test.org'
        ) >= 0,
      { what: 'the alias of the add' }
    );
    expect(
      seen('DELETE /address/forwards/jr-old@test.org/targets/gone@test.org')
    ).to.be.at.least(0);
    expect(
      seen('DELETE /address/forwards/jr-old@test.org/targets/jr-own@test.org')
    ).to.equal(-1);
    expect(
      seen('DELETE /address/forwards/jr-alias@test.org/targets/gone@test.org')
    ).to.be.within(
      0,
      seen('PUT /address/aliases/jr-old@test.org/sources/jr-alias@test.org')
    );

    james['/address/forwards/jr-alias2@test.org'] = [
      200,
      [{ mailAddress: 'gone@test.org' }],
    ];
    await dm.ldap.modify(dn, {
      add: { mailAlternateAddress: 'jr-alias2@test.org' },
    });
    await waitFor(
      () =>
        seen(
          'PUT /address/aliases/jr-old@test.org/sources/jr-alias2@test.org'
        ) >= 0,
      { what: 'the added alias' }
    );
    expect(
      seen('DELETE /address/forwards/jr-alias2@test.org/targets/gone@test.org')
    ).to.be.within(
      0,
      seen('PUT /address/aliases/jr-old@test.org/sources/jr-alias2@test.org')
    );
  });

  it('treats a mail gained by a modify as the add does', async () => {
    await dm.ldap.add(dn, {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'jamesrenamed',
      cn: 'Jane Renamed',
      sn: 'Renamed',
      displayName: 'Jane Renamed',
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    calls = [];
    james['/address/forwards/jr-gained@test.org'] = [
      200,
      [{ mailAddress: 'gone@test.org' }],
    ];

    await dm.ldap.modify(dn, { add: { mail: 'jr-gained@test.org' } });
    await waitFor(
      () => seen('POST /users/jr-gained@test.org/identities') >= 0,
      { what: 'the identity of the gained address' }
    );
    expect(
      seen('DELETE /address/forwards/jr-gained@test.org/targets/gone@test.org')
    ).to.be.at.least(0);
    expect(calls.map(c => c.call).filter(c => c.includes('/rename/'))).to.eql(
      []
    );
  });
});
