import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('James and groups', () => {
  const timestamp = Date.now();
  let userBase: string;
  let groupBase: string;
  let listBase: string;
  let mailboxTypeBase: string;
  let alice: string;
  let bob: string;

  let dm: DM;
  let groups: LdapGroups;
  const calls: string[] = [];
  const users: string[] = [];

  // James follows the writes after they have answered
  const settle = (): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, 500));

  const addGroup = async (
    name: string,
    type?: string,
    base = groupBase
  ): Promise<string> => {
    const cn = `${name}-${timestamp}`;
    const dn = `cn=${cn},${base}`;
    await groups.addGroup(dn, [alice], {
      mail: `${cn}@test.org`,
      ...(type && { twakeMailboxType: `cn=${type},${mailboxTypeBase}` }),
      twakeDepartmentLink: groupBase,
      twakeDepartmentPath: 'Test',
    });
    await settle();
    return dn;
  };

  const user = (name: string): string => `${name}-${timestamp}@test.org`;
  const mailbox = (name: string): string =>
    `/domains/test.org/team-mailboxes/${name}-${timestamp}@test.org`;

  const addressGroupCalls = (): string[] =>
    calls.filter(call => call.includes('/address/groups'));

  // The user hooks also see a group's mail (identity, rename)
  const groupCalls = (): string[] =>
    calls.filter(
      call =>
        call.includes('/address/groups') || call.includes('/team-mailboxes')
    );

  before(async function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);

    userBase = `ou=users,${process.env.DM_LDAP_BASE}`;
    groupBase =
      process.env.DM_LDAP_GROUP_BASE || `ou=groups,${process.env.DM_LDAP_BASE}`;
    listBase = `ou=lists,${groupBase}`;
    mailboxTypeBase = `ou=twakeMailboxType,ou=nomenclature,${process.env.DM_LDAP_BASE}`;

    dm = new DM();
    dm.config.delegation_attribute = 'twakeDelegatedUsers';
    dm.config.james_init_delay = 0;
    dm.config.group_classes = ['top', 'groupOfNames', 'twakeStaticGroup'];
    await dm.ready;
    groups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', groups);
    await dm.registerPlugin('james', new James(dm));

    const scope = nock(
      process.env.DM_JAMES_WEBADMIN_URL || 'http://localhost:8000'
    ).persist();
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'])
      scope.intercept(/.*/, method).reply(uri => {
        calls.push(`${method} ${decodeURIComponent(uri)}`);
        return method === 'GET' ? [200, []] : [204];
      });

    for (const [dn, ou] of [
      [userBase, 'users'],
      [listBase, 'lists'],
    ])
      try {
        await dm.ldap.add(dn, {
          objectClass: ['organizationalUnit', 'top'],
          ou,
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
        mail: user(uid),
      });
      users.push(dn);
    }
    [alice, bob] = users;
  });

  // The cleanup of the previous test may still be on its way to James
  beforeEach(async () => {
    await settle();
    calls.length = 0;
  });

  afterEach(() => {
    dm.config.james_mailing_list_branch = [];
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

  describe('mailing lists', () => {
    for (const type of ['mailingList', undefined])
      it(`creates no address group for a list ${type ? `of type ${type}` : 'without a mailbox type'}`, async () => {
        const dn = await addGroup(`ml-${type ?? 'untyped'}`, type);
        await groups.addMember(dn, bob);
        await groups.deleteMember(dn, alice);
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
      await groups.addMember(dn, bob);
      await groups.deleteGroup(dn);
      await settle();

      expect(calls).to.deep.equal([]);
    });
  });

  describe('team mailboxes', () => {
    it('creates the mailbox, then follows the members API', async () => {
      const dn = await addGroup('tm-members', 'teamMailbox');
      expect(groupCalls()).to.deep.equal([
        `PUT ${mailbox('tm-members')}`,
        `PUT ${mailbox('tm-members')}/members/${user('mlalice')}`,
      ]);

      calls.length = 0;
      await groups.addMember(dn, bob);
      await settle();
      await groups.deleteMember(dn, alice);
      await settle();
      expect(groupCalls()).to.deep.equal([
        `PUT ${mailbox('tm-members')}/members/${user('mlbob')}`,
        `DELETE ${mailbox('tm-members')}/members/${user('mlalice')}`,
      ]);
      await groups.deleteGroup(dn);
    });

    it('follows a replace of the members', async () => {
      const dn = await addGroup('tm-replace', 'teamMailbox');
      calls.length = 0;

      await dm.ldap.modify(dn, { replace: { member: [bob] } });
      await settle();

      expect(groupCalls()).to.have.members([
        `PUT ${mailbox('tm-replace')}/members/${user('mlbob')}`,
        `DELETE ${mailbox('tm-replace')}/members/${user('mlalice')}`,
      ]);
      await groups.deleteGroup(dn);
    });

    it('empties the mailbox when the group is deleted, and keeps it', async () => {
      const dn = await addGroup('tm-delete', 'teamMailbox');
      calls.length = 0;

      await groups.deleteGroup(dn);
      await settle();

      expect(groupCalls()).to.deep.equal([
        `DELETE ${mailbox('tm-delete')}/members/${user('mlalice')}`,
      ]);
    });

    it('empties the mailbox when the group stops being one, and creates it back', async () => {
      const dn = await addGroup('tm-type', 'teamMailbox');
      calls.length = 0;

      await groups.modifyGroup(dn, {
        replace: { twakeMailboxType: `cn=group,${mailboxTypeBase}` },
      });
      await settle();
      expect(groupCalls()).to.deep.equal([
        `DELETE ${mailbox('tm-type')}/members/${user('mlalice')}`,
      ]);

      calls.length = 0;
      await groups.modifyGroup(dn, {
        replace: { twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}` },
      });
      await settle();
      expect(groupCalls()).to.deep.equal([
        `PUT ${mailbox('tm-type')}`,
        `PUT ${mailbox('tm-type')}/members/${user('mlalice')}`,
      ]);
      await groups.deleteGroup(dn);
    });

    it('moves the members to the new address of the mailbox', async () => {
      const dn = await addGroup('tm-old', 'teamMailbox');
      calls.length = 0;

      await groups.modifyGroup(dn, {
        replace: { mail: `tm-new-${timestamp}@test.org` },
      });
      await settle();

      expect(groupCalls()).to.deep.equal([
        `DELETE ${mailbox('tm-old')}/members/${user('mlalice')}`,
        `PUT ${mailbox('tm-new')}`,
        `PUT ${mailbox('tm-new')}/members/${user('mlalice')}`,
      ]);
      await groups.deleteGroup(dn);
    });

    it('creates none in a mailing list branch, nor follows its members', async () => {
      dm.config.james_mailing_list_branch = [listBase];
      const dn = await addGroup('tm-inlist', 'teamMailbox', listBase);
      await groups.addMember(dn, bob);
      await groups.deleteGroup(dn);
      await settle();

      expect(groupCalls()).to.deep.equal([]);
    });
  });
});
