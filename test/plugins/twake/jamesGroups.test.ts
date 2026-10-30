import nock from 'nock';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import James from '../../../src/plugins/twake/james';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { BadRequestError, ConflictError } from '../../../src/lib/errors';
import type { SearchResult } from '../../../src/lib/ldapActions';
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
    `/domains/test.org/team-mailboxes/${name}-${timestamp}`;

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
    dm.config.group_class = ['top', 'groupOfNames', 'twakeStaticGroup'];
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
      scope.intercept(/.*/, method).reply((uri: string) => {
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

    it('refuses a member under an attribute option', async () => {
      // `member;lang-en` is a value of its own, which the hooks guarding
      // `member` would not follow
      const dn = await addGroup('tm-option', 'teamMailbox');
      await reached(created('tm-option'));
      calls.length = 0;

      let error: unknown;
      await dm.ldap
        .modify(dn, { add: { 'member;lang-en': bob } })
        .catch(e => (error = e));
      expect(error).to.be.instanceOf(BadRequestError);
      await groups.deleteGroup(dn);
      const emptied = [
        `DELETE ${mailbox('tm-option')}/members/${user('mlalice')}`,
      ];
      expect(await reached(emptied)).to.have.members(emptied);
    });

    it('reads the address of the mailbox from --mail-attribute', async () => {
      const name = `tm-attr-${timestamp}`;
      const mailAttribute = dm.config.mail_attribute;
      dm.config.mail_attribute = 'twakeMail';
      const other = new James(dm);
      dm.config.mail_attribute = mailAttribute;

      await other.hooks.onLdapEntryChange!(
        `cn=${name},${groupBase}`,
        null,
        {
          dn: `cn=${name},${groupBase}`,
          objectClass: ['top', 'groupOfNames'],
          twakeMail: `${name}@test.org`,
          twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
          member: [],
        },
        {}
      );
      expect(await reached([`PUT ${mailbox('tm-attr')}`])).to.deep.equal([
        `PUT ${mailbox('tm-attr')}`,
      ]);
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

  // linagora/twake-directory-manager#66: Twake Mail adds any address to a
  // team mailbox, so the directory keeps them to its domain.
  describe('members of another domain', () => {
    let carol: string;

    const refusal = async (write: Promise<unknown>): Promise<unknown> => {
      try {
        await write;
      } catch (e) {
        return e;
      }
      return undefined;
    };

    const membersOf = async (dn: string): Promise<string[]> => {
      const { searchEntries } = (await dm.ldap.search(
        { paged: false, scope: 'base', attributes: ['member'] },
        dn
      )) as SearchResult;
      const value = searchEntries[0]?.member;
      return (Array.isArray(value) ? value : [value]).map(String);
    };

    before(async () => {
      carol = `uid=mlcarol-${timestamp},${userBase}`;
      await dm.ldap.add(carol, {
        objectClass: ['top', 'inetOrgPerson'],
        cn: 'mlcarol',
        sn: 'mlcarol',
        uid: `mlcarol-${timestamp}`,
        mail: `mlcarol-${timestamp}@other.org`,
      });
      users.push(carol);
    });

    afterEach(() => {
      dm.config.james_team_mailbox_any_domain = false;
    });

    it('refuses adding one to a team mailbox', async () => {
      const dn = await addGroup('tm-foreign', 'teamMailbox');
      await reached(created('tm-foreign'));
      calls.length = 0;

      const error = await refusal(groups.addMember(dn, carol));
      expect(error).to.be.instanceOf(ConflictError);
      expect(String(error)).to.include(`mlcarol-${timestamp}@other.org`);
      expect(await membersOf(dn)).not.to.include(carol);
      await settle();
      expect(groupCalls()).to.deep.equal([]);
      await deleteTeamMailbox(dn, 'tm-foreign', 'mlalice');
    });

    it('refuses creating a team mailbox holding one', async () => {
      const dn = `cn=tm-born-${timestamp},${groupBase}`;
      const error = await refusal(
        groups.addGroup(dn, [alice, carol], {
          mail: `tm-born-${timestamp}@test.org`,
          twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}`,
          twakeDepartmentLink: groupBase,
          twakeDepartmentPath: 'Test',
        })
      );
      expect(error).to.be.instanceOf(ConflictError);
      await settle();
      expect(groupCalls()).to.deep.equal([]);
    });

    it('refuses turning a list holding one into a team mailbox', async () => {
      const dn = await addGroup('tm-turned', 'mailingList');
      await groups.addMember(dn, carol);

      const error = await refusal(
        groups.modifyGroup(dn, {
          replace: { twakeMailboxType: `cn=teamMailbox,${mailboxTypeBase}` },
        })
      );
      expect(error).to.be.instanceOf(ConflictError);
      await groups.deleteGroup(dn);
      await settle();
      expect(groupCalls()).to.deep.equal([]);
    });

    it('refuses moving a team mailbox to another domain than its members', async () => {
      const dn = await addGroup('tm-moved', 'teamMailbox');
      await reached(created('tm-moved'));
      calls.length = 0;

      const error = await refusal(
        groups.modifyGroup(dn, {
          replace: { mail: `tm-moved-${timestamp}@other.org` },
        })
      );
      expect(error).to.be.instanceOf(ConflictError);
      // The caller may not be allowed to read the members already there
      expect(String(error)).not.to.include(user('mlalice'));
      expect(String(error)).to.include('some of the members it holds');
      await settle();
      expect(groupCalls()).to.deep.equal([]);
      await deleteTeamMailbox(dn, 'tm-moved', 'mlalice');
    });

    it('refuses one brought by a replace, naming only it', async () => {
      const dn = await addGroup('tm-replaced', 'teamMailbox');
      await reached(created('tm-replaced'));
      calls.length = 0;

      const error = await refusal(
        dm.ldap.modify(dn, { replace: { member: [alice, carol] } })
      );
      expect(error).to.be.instanceOf(ConflictError);
      expect(String(error)).to.include(`mlcarol-${timestamp}@other.org`);
      expect(String(error)).not.to.include('members it holds');
      expect(await membersOf(dn)).not.to.include(carol);
      await deleteTeamMailbox(dn, 'tm-replaced', 'mlalice');
    });

    it('refuses one under an attribute option', async () => {
      const dn = await addGroup('tm-option', 'teamMailbox');
      await reached(created('tm-option'));

      const error = await refusal(
        dm.ldap.modify(dn, { add: { member: bob, 'member;lang-en': carol } })
      );
      expect(error).to.be.instanceOf(BadRequestError);
      expect(await membersOf(dn)).not.to.include(carol);
      await deleteTeamMailbox(dn, 'tm-option', 'mlalice');
    });

    it('applies the changes in the order they are sent', async () => {
      const dn = await addGroup('tm-order', 'teamMailbox');
      await reached(created('tm-order'));

      // Added, then deleted: the mailbox never holds it
      await dm.ldap.modify(dn, {
        add: { member: carol },
        delete: { member: carol },
      });
      expect(await membersOf(dn)).not.to.include(carol);
      await deleteTeamMailbox(dn, 'tm-order', 'mlalice');
    });

    it('lets a write that ends the team mailbox bring one', async () => {
      const dn = await addGroup('tm-ended', 'teamMailbox');
      await reached(created('tm-ended'));

      await dm.ldap.modify(dn, {
        add: { member: carol },
        delete: ['twakeMailboxType'],
      });
      expect(await membersOf(dn)).to.include(carol);
      calls.length = 0;
      await groups.deleteGroup(dn);
      await settle();
    });

    it('keeps a team mailbox holding one editable', async () => {
      dm.config.james_team_mailbox_any_domain = true;
      const dn = await addGroup('tm-legacy', 'teamMailbox');
      await reached(created('tm-legacy'));
      await groups.addMember(dn, carol);
      dm.config.james_team_mailbox_any_domain = false;

      await groups.addMember(dn, bob);
      await groups.deleteMember(dn, carol);
      const held = await membersOf(dn);
      expect(held).to.include(bob);
      expect(held).not.to.include(carol);
      calls.length = 0;
      await groups.deleteGroup(dn);
      await settle();
    });

    it('lets a mailing list hold one', async () => {
      const dn = await addGroup('ml-foreign', 'mailingList');
      await groups.addMember(dn, carol);
      expect(await membersOf(dn)).to.include(carol);
      await groups.deleteGroup(dn);
    });

    it('lets a team mailbox hold one with --james-team-mailbox-any-domain', async () => {
      dm.config.james_team_mailbox_any_domain = true;
      const dn = await addGroup('tm-any', 'teamMailbox');
      await reached(created('tm-any'));
      calls.length = 0;

      await groups.addMember(dn, carol);
      const added = [
        `PUT ${mailbox('tm-any')}/members/mlcarol-${timestamp}@other.org`,
      ];
      expect(await reached(added)).to.deep.equal(added);
      calls.length = 0;
      await groups.deleteGroup(dn);
      await reached([
        `DELETE ${mailbox('tm-any')}/members/${user('mlalice')}`,
        `DELETE ${mailbox('tm-any')}/members/mlcarol-${timestamp}@other.org`,
      ]);
    });

    it('publishes the setting for the clients', () => {
      expect(james.getConfigApiData()).to.deep.equal({
        teamMailboxAnyDomain: false,
      });
    });
  });
});
