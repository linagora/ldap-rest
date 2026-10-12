import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';
import { waitFor } from '../../helpers/waitFor';

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
  let james: James;
  const calls: string[] = [];
  const users: string[] = [];

  // No call can be awaited to show that none is made: a regression would
  // send it within this delay
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
    return dn;
  };

  const user = (name: string): string => `${name}-${timestamp}@test.org`;
  const mailbox = (name: string): string =>
    `/domains/test.org/team-mailboxes/${name}-${timestamp}@test.org`;

  const addressGroupCalls = (): string[] =>
    calls.filter(call => call.includes('/address/groups'));

  // Leaves out the identities of the users created in before()
  const groupCalls = (): string[] =>
    calls.filter(
      call =>
        call.includes('/address/groups') || call.includes('/team-mailboxes')
    );

  // James follows a write after it has answered
  const reached = async (expected: string[]): Promise<string[]> => {
    await waitFor(() => groupCalls().length >= expected.length, {
      what: expected.join(', '),
    });
    return groupCalls();
  };

  // The calls creating a team mailbox with alice in it
  const created = (name: string): string[] => [
    `PUT ${mailbox(name)}`,
    `PUT ${mailbox(name)}/members/${user('mlalice')}`,
  ];

  const deleteTeamMailbox = async (
    dn: string,
    name: string,
    member: string
  ) => {
    calls.length = 0;
    await groups.deleteGroup(dn);
    await reached([`DELETE ${mailbox(name)}/members/${user(member)}`]);
  };

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
    await dm.ready;
    groups = new LdapGroups(dm);
    await dm.registerPlugin('onLdapChange', new OnLdapChange(dm));
    await dm.registerPlugin('ldapGroups', groups);
    james = new James(dm);
    await dm.registerPlugin('james', james);

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

  beforeEach(() => {
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

      expect(groupCalls()).to.deep.equal([]);
    });
  });

  describe('team mailboxes', () => {
    it('creates the mailbox, then follows the members API', async () => {
      const dn = await addGroup('tm-members', 'teamMailbox');
      expect(await reached(created('tm-members'))).to.deep.equal(
        created('tm-members')
      );

      calls.length = 0;
      const added = `PUT ${mailbox('tm-members')}/members/${user('mlbob')}`;
      await groups.addMember(dn, bob);
      await reached([added]);
      const removed = `DELETE ${mailbox('tm-members')}/members/${user('mlalice')}`;
      await groups.deleteMember(dn, alice);
      expect(await reached([added, removed])).to.deep.equal([added, removed]);
      await deleteTeamMailbox(dn, 'tm-members', 'mlbob');
    });

    it('follows a replace of the members', async () => {
      const dn = await addGroup('tm-replace', 'teamMailbox');
      await reached(created('tm-replace'));
      calls.length = 0;

      await dm.ldap.modify(dn, { replace: { member: [bob] } });
      const expected = [
        `PUT ${mailbox('tm-replace')}/members/${user('mlbob')}`,
        `DELETE ${mailbox('tm-replace')}/members/${user('mlalice')}`,
      ];
      expect(await reached(expected)).to.have.members(expected);
      await deleteTeamMailbox(dn, 'tm-replace', 'mlbob');
    });

    it('empties the mailbox when the group is deleted, and keeps it', async () => {
      const dn = await addGroup('tm-delete', 'teamMailbox');
      await reached(created('tm-delete'));
      calls.length = 0;

      await groups.deleteGroup(dn);
      const expected = [
        `DELETE ${mailbox('tm-delete')}/members/${user('mlalice')}`,
      ];
      expect(await reached(expected)).to.deep.equal(expected);
    });

    it('empties the mailbox when the group stops being one, and creates it back', async () => {
      const dn = await addGroup('tm-type', 'teamMailbox');
      await reached(created('tm-type'));
      calls.length = 0;

      await groups.modifyGroup(dn, {
        replace: { twakeMailboxType: `cn=group,${mailboxTypeBase}` },
      });
      const emptied = [
        `DELETE ${mailbox('tm-type')}/members/${user('mlalice')}`,
      ];
      expect(await reached(emptied)).to.deep.equal(emptied);

      calls.length = 0;
      await groups.modifyGroup(dn, {
        replace: { twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}` },
      });
      expect(await reached(created('tm-type'))).to.deep.equal(
        created('tm-type')
      );
      await deleteTeamMailbox(dn, 'tm-type', 'mlalice');
    });

    it('moves the members to the new address of the mailbox', async () => {
      const dn = await addGroup('tm-old', 'teamMailbox');
      await reached(created('tm-old'));
      calls.length = 0;

      await groups.modifyGroup(dn, {
        replace: { mail: `tm-new-${timestamp}@test.org` },
      });
      const expected = [
        `DELETE ${mailbox('tm-old')}/members/${user('mlalice')}`,
        `PUT ${mailbox('tm-new')}`,
        `PUT ${mailbox('tm-new')}/members/${user('mlalice')}`,
      ];
      expect(await reached(expected)).to.deep.equal(expected);
      await deleteTeamMailbox(dn, 'tm-new', 'mlalice');
    });

    it('makes no user call for the address of a group', async () => {
      const list = await addGroup('ml-user', 'mailingList');
      const dn = await addGroup('tm-user', 'teamMailbox');
      await reached(created('tm-user'));
      await groups.modifyGroup(dn, {
        replace: { mail: `tm-renamed-${timestamp}@test.org` },
      });
      await reached([
        ...created('tm-user'),
        `DELETE ${mailbox('tm-user')}/members/${user('mlalice')}`,
        ...created('tm-renamed'),
      ]);
      await settle();

      expect(
        calls.filter(
          call =>
            call.includes('/users/') &&
            /(ml-user|tm-user|tm-renamed)-/.test(call)
        )
      ).to.deep.equal([]);
      await groups.deleteGroup(list);
      await deleteTeamMailbox(dn, 'tm-renamed', 'mlalice');
    });

    it('leaves a group out of the quota, forward and delegation hooks', async () => {
      const dn = await addGroup('tm-hooks', 'teamMailbox');
      await reached(created('tm-hooks'));
      calls.length = 0;
      const address = `tm-hooks-${timestamp}@test.org`;

      // The shipped group schemas carry none of these attributes: a raw
      // write, or a schema extending them, is what would fire the hooks
      await james.hooks.onLdapQuotaChange!(dn, address, 0, 1024);
      await james.hooks.onLdapForwardChange!(dn, address, [], [user('mlbob')]);
      await james.hooks.onLdapChange!(dn, {
        twakeDelegatedUsers: [[], [bob]],
      });

      expect(calls).to.deep.equal([]);
      await deleteTeamMailbox(dn, 'tm-hooks', 'mlalice');
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
