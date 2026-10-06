import { expect } from 'chai';
import type { SearchResult } from 'ldapts';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import Scim from '../../../src/plugins/scim/scim';
import TwakeGroups from '../../../src/plugins/twake/groups';

const ORGS = `ou=tg-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = (org: string): string => `ou=${org},${ORGS}`;
const userDn = (org: string, uid: string): string =>
  `uid=${uid},ou=users,${orgDn(org)}`;
const groupDn = (org: string, cn: string): string =>
  `cn=${cn},ou=groups,${orgDn(org)}`;

describe('Twake groups plugin', function () {
  let dm: DM;
  let plugin: TwakeGroups;

  const ou = (dn: string): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
      })
      .catch(() => undefined);

  const user = (org: string, uid: string, extra = {}): Promise<unknown> =>
    dm.ldap.add(userDn(org, uid), {
      objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
      cn: uid,
      sn: uid,
      uid,
      mail: `${uid}@${org}.example.org`,
      ...extra,
    });

  const group = (
    org: string,
    cn: string,
    members: string[]
  ): Promise<unknown> =>
    dm.ldap.add(groupDn(org, cn), {
      objectClass: ['top', 'groupOfNames'],
      cn,
      member: [dm.config.group_dummy_user as string, ...members],
    });

  const membersOf = async (org: string, cn: string): Promise<string[]> => {
    const { searchEntries } = (await dm.ldap.search(
      { paged: false, scope: 'base', attributes: ['member'] },
      groupDn(org, cn)
    )) as { searchEntries: { member?: string | string[] }[] };
    const m = searchEntries[0].member;
    return m === undefined ? [] : Array.isArray(m) ? m : [m];
  };

  before(async () => {
    dm = new DM();
    dm.config.twake_group_base = `ou=groups,ou={org},${ORGS}`;
    dm.config.twake_group_user_base = `ou=users,ou={org},${ORGS}`;
    dm.config.twake_lifecycle_deleted_attribute = 'employeeType';
    dm.config.twake_lifecycle_deleted_value = 'deleted';
    await dm.ready;
    plugin = new TwakeGroups(dm);
    await dm.registerPlugin('core/twake/groups', plugin);
    dm.config.scim_group_base = `ou=groups,${orgDn('acme')}`;
    dm.config.scim_group_object_class = ['top', 'groupOfNames'];
    await dm.registerPlugin('core/scim', new Scim(dm));
    await ou(ORGS);
    for (const org of ['acme', 'other']) {
      await ou(orgDn(org));
      await ou(`ou=users,${orgDn(org)}`);
      await ou(`ou=groups,${orgDn(org)}`);
    }
  });

  afterEach(async () => {
    for (const dn of [
      groupDn('acme', 'team'),
      groupDn('other', 'team'),
      userDn('acme', 'tg-alice'),
      userDn('acme', 'tg-bob'),
      userDn('other', 'tg-eve'),
    ])
      await dm.ldap.delete(dn).catch(() => undefined);
  });

  after(async () => {
    for (const org of ['acme', 'other']) {
      await dm.ldap.delete(`ou=users,${orgDn(org)}`).catch(() => undefined);
      await dm.ldap.delete(`ou=groups,${orgDn(org)}`).catch(() => undefined);
      await dm.ldap.delete(orgDn(org)).catch(() => undefined);
    }
    await dm.ldap.delete(ORGS).catch(() => undefined);
  });

  it('refuses a pattern without {org}', () => {
    const base = dm.config.twake_group_base;
    dm.config.twake_group_base = `ou=groups,${ORGS}`;
    try {
      expect(() => new TwakeGroups(dm)).to.throw(
        /--twake-group-base must hold \{org\}/
      );
    } finally {
      dm.config.twake_group_base = base;
    }
  });

  it('reads the organization of a group off its DN', () => {
    expect(plugin.organizationOf(groupDn('acme', 'team'))).to.equal('acme');
    expect(
      plugin.organizationOf(`cn=team, ou=groups, ${orgDn('a\\,b')}`)
    ).to.equal('a,b');
    expect(plugin.organizationOf(userDn('acme', 'x'))).to.equal(undefined);
  });

  it('adds a group of its organization members and the placeholder', async () => {
    await user('acme', 'tg-alice');
    await group('acme', 'team', [userDn('acme', 'tg-alice')]);
    expect(await membersOf('acme', 'team')).to.have.length(2);
  });

  it('refuses a member of another organization, on add and on modify', async () => {
    await user('other', 'tg-eve');
    let error: unknown;
    await group('acme', 'team', [userDn('other', 'tg-eve')]).catch(
      e => (error = e)
    );
    expect(String(error)).to.match(/is not a user of organization acme/);

    await group('acme', 'team', []);
    for (const changes of [
      { add: { member: userDn('other', 'tg-eve') } },
      { replace: { member: [userDn('other', 'tg-eve')] } },
    ]) {
      error = undefined;
      await dm.ldap
        .modify(groupDn('acme', 'team'), changes)
        .catch(e => (error = e));
      expect(String(error)).to.match(/is not a user of organization acme/);
    }
  });

  it('refuses a group moved to another organization with its members', async () => {
    await user('acme', 'tg-alice');
    await group('acme', 'team', [userDn('acme', 'tg-alice')]);
    let error: unknown;
    await dm.ldap
      .rename(groupDn('acme', 'team'), groupDn('other', 'team'))
      .catch(e => (error = e));
    expect(String(error)).to.match(/is not a user of organization other/);
    expect(await membersOf('acme', 'team')).to.have.length(2);
  });

  it('hides a tombstone from member lists, and keeps its membership', async () => {
    await user('acme', 'tg-alice', { employeeType: 'deleted' });
    await user('acme', 'tg-bob');
    await group('acme', 'team', [
      userDn('acme', 'tg-alice'),
      userDn('acme', 'tg-bob'),
    ]);
    const members = await membersOf('acme', 'team');
    expect(members.map(m => m.toLowerCase())).to.not.include(
      userDn('acme', 'tg-alice').toLowerCase()
    );
    expect(members).to.have.length(2);
    const { searchEntries } = (await dm.ldap.search(
      {
        paged: false,
        scope: 'one',
        filter: `(member=${userDn('acme', 'tg-alice')})`,
        attributes: ['cn'],
      },
      `ou=groups,${orgDn('acme')}`
    )) as { searchEntries: unknown[] };
    expect(searchEntries).to.have.length(1);
  });

  it('creates a plain groupOfNames SCIM group without a creation date', async () => {
    await supertest(dm.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'team',
      })
      .expect(201);
    const { searchEntries } = (await dm.ldap.search(
      { paged: false, scope: 'base', attributes: ['*'] },
      groupDn('acme', 'team')
    )) as SearchResult;
    expect(searchEntries[0]).not.to.have.property('twakeCreatedAt');
  });

  it('leaves the member cleanup of an erase to the directory', () => {
    expect(plugin.hooks.ldapdeletedone).to.equal(undefined);
  });
});
