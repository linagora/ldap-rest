import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
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
  let groups: LdapGroups;
  const calls: string[] = [];
  const users: string[] = [];

  // The group hooks are launched without being awaited
  const settle = (): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, 500));

  const addGroup = async (name: string, type?: string): Promise<string> => {
    const cn = `${name}-${timestamp}`;
    const dn = `cn=${cn},${groupBase}`;
    await groups.addGroup(dn, [alice], {
      mail: `${cn}@test.org`,
      ...(type && { twakeMailboxType: `cn=${type},${mailboxTypeBase}` }),
      twakeDepartmentLink: groupBase,
      twakeDepartmentPath: 'Test',
    });
    return dn;
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
    dm.config.group_classes = ['top', 'groupOfNames', 'twakeStaticGroup'];
    await dm.ready;
    james = new James(dm);
    groups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', groups);
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
      users.push(dn);
    }
    [alice, bob] = users;
  });

  beforeEach(() => {
    calls.length = 0;
  });

  after(async () => {
    nock.cleanAll();
    for (const dn of users)
      try {
        await dm.ldap.delete(dn);
      } catch {
        // Already gone
      }
  });

  for (const type of ['mailingList', undefined])
    it(`creates no address group for a list ${type ? `of type ${type}` : 'without a mailbox type'}`, async () => {
      const dn = await addGroup(`ml-${type ?? 'untyped'}`, type);
      await settle();
      await groups.deleteGroup(dn);
      await settle();

      expect(addressGroupCalls()).to.deep.equal([]);
    });

  it('sends nothing to James for a group without mail', async () => {
    const dn = `cn=ml-nomail-${timestamp},${groupBase}`;
    await groups.addGroup(dn, [alice], {
      twakeDepartmentLink: groupBase,
      twakeDepartmentPath: 'Test',
    });
    await settle();
    await groups.deleteGroup(dn);
    await settle();

    expect(calls).to.deep.equal([]);
  });

  it('ldapgroupmodifydone sends no member change of a list to James', async () => {
    const dn = await addGroup('ml-members', 'mailingList');
    await settle();

    await james.hooks.ldapgroupmodifydone!([dn, { add: { member: bob } }, 0]);
    await james.hooks.ldapgroupmodifydone!([
      dn,
      { delete: { member: alice } },
      0,
    ]);
    await groups.deleteGroup(dn);
    await settle();

    expect(addressGroupCalls()).to.deep.equal([]);
  });

  it('still creates a team mailbox with its members', async () => {
    const dn = await addGroup('ml-team', 'teamMailbox');
    const mailbox = `/domains/test.org/team-mailboxes/ml-team-${timestamp}@test.org`;
    await settle();

    expect(calls).to.include.members([
      `PUT ${mailbox}`,
      `PUT ${mailbox}/members/mlalice-${timestamp}@test.org`,
    ]);
    await groups.deleteGroup(dn);
  });
});
