import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import type { AttributesList } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('James and mailing lists', () => {
  const timestamp = Date.now();
  let userBase: string;
  let groupBase: string;
  let mailboxTypeBase: string;
  let alice: string;
  let bob: string;

  let dm: DM;
  let james: James;
  const calls: string[] = [];
  const created: string[] = [];

  const group = async (
    name: string,
    type?: string
  ): Promise<[string, AttributesList]> => {
    const cn = `${name}-${timestamp}`;
    const dn = `cn=${cn},${groupBase}`;
    const entry: AttributesList = {
      objectClass: ['top', 'groupOfNames', 'twakeStaticGroup'],
      cn,
      mail: `${cn}@test.org`,
      member: [alice],
      twakeDepartmentLink: groupBase,
      twakeDepartmentPath: 'Test',
    };
    if (type) entry.twakeMailboxType = `cn=${type},${mailboxTypeBase}`;
    await dm.ldap.add(dn, entry);
    created.unshift(dn);
    return [dn, entry];
  };

  const addressGroupCalls = (): string[] =>
    calls.filter(call => call.includes('/address/groups'));

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
    groupBase =
      process.env.DM_LDAP_GROUP_BASE || `ou=groups,${process.env.DM_LDAP_BASE}`;
    mailboxTypeBase = `ou=twakeMailboxType,ou=nomenclature,${process.env.DM_LDAP_BASE}`;

    dm = new DM();
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    dm.config.james_init_delay = 0;
    await dm.ready;
    james = new James(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', new LdapGroups(dm));
    await dm.registerPlugin('james', james);

    const scope = nock(
      process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
    ).persist();
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
      scope.intercept(/.*/, method).reply(uri => {
        calls.push(`${method} ${decodeURIComponent(uri)}`);
        return method === 'GET' ? [200, []] : [204];
      });

    try {
      await dm.ldap.add(userBase, {
        objectClass: ['organizationalUnit', 'top'],
        ou: 'users',
      });
    } catch {
      // Already there
    }
    for (const uid of ['mlalice', 'mlbob']) {
      const dn = `uid=${uid}-${timestamp},${userBase}`;
      await dm.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: uid,
        sn: uid,
        uid: `${uid}-${timestamp}`,
        mail: `${uid}-${timestamp}@test.org`,
      });
      created.push(dn);
    }
    [alice, bob] = created;
  });

  beforeEach(() => {
    calls.length = 0;
  });

  after(async () => {
    nock.cleanAll();
    for (const dn of created)
      try {
        await dm.ldap.delete(dn);
      } catch {
        // Already gone
      }
  });

  for (const type of ['mailingList', undefined])
    it(`gives James no address group for a list ${type ? `of type ${type}` : 'without a mailbox type'}`, async () => {
      const [dn, entry] = await group(`ml-${type ?? 'untyped'}`, type);

      await james.hooks.ldapgroupadddone!([dn, entry]);
      await james.hooks.ldapgroupmodifydone!([dn, { add: { member: bob } }, 0]);
      await james.hooks.ldapgroupmodifydone!([
        dn,
        { delete: { member: alice } },
        0,
      ]);
      await james.hooks.ldapgroupdeletedone!(dn);

      expect(addressGroupCalls()).to.deep.equal([]);
    });

  it('gives James no address group when a group becomes a list or stops being one', async () => {
    const [listDn] = await group('ml-from-list', 'mailingList');
    const [groupDn] = await group('ml-from-group', 'group');

    await james.hooks.ldapgroupmodifydone!([
      listDn,
      { replace: { twakeMailboxType: `cn=group,${mailboxTypeBase}` } },
      0,
    ]);
    await james.hooks.ldapgroupmodifydone!([
      groupDn,
      { replace: { twakeMailboxType: `cn=mailingList,${mailboxTypeBase}` } },
      0,
    ]);

    expect(addressGroupCalls()).to.deep.equal([]);
  });

  it('still creates a team mailbox and follows its members', async () => {
    const [dn, entry] = await group('ml-team', 'teamMailbox');
    const mailbox = `/domains/test.org/team-mailboxes/ml-team-${timestamp}@test.org`;

    await james.hooks.ldapgroupadddone!([dn, entry]);
    await james.hooks.ldapgroupmodifydone!([dn, { add: { member: bob } }, 0]);
    await james.hooks.ldapgroupmodifydone!([
      dn,
      { delete: { member: alice } },
      0,
    ]);

    expect(calls).to.include.members([
      `PUT ${mailbox}`,
      `PUT ${mailbox}/members/mlalice-${timestamp}@test.org`,
      `PUT ${mailbox}/members/mlbob-${timestamp}@test.org`,
      `DELETE ${mailbox}/members/mlalice-${timestamp}@test.org`,
    ]);
    expect(addressGroupCalls()).to.deep.equal([]);
  });
});
