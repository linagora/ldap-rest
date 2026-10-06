import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import TwakeGroups from '../../../src/plugins/twake/groups';
import TwakeSpaces from '../../../src/plugins/twake/spaces';
import { waitFor } from '../../helpers/waitFor';

const ORGS = `ou=tss-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = `ou=acme,${ORGS}`;
const users = `ou=users,${orgDn}`;
const userDn = (uid: string): string => `uid=${uid},${users}`;
const UIDS = ['tss-alice', 'tss-bob', 'tss-carol', 'tss-dave'];
// A multi-valued attribute of inetOrgPerson, so the test needs no Twake schema
const ROLE = 'carLicense';

describe('Twake spaces: user roles', function () {
  let dm: DM;
  let api: supertest.Agent;
  let spaces: TwakeSpaces;
  const route = `/api/v1/organizations/acme/spaces`;
  const groupRoute = `/api/v1/organizations/acme/groups`;

  const ou = (dn: string): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
      })
      .catch(() => undefined);

  const rolesOf = async (uid: string): Promise<string[]> => {
    const { searchEntries } = (await dm.ldap.search(
      { paged: false, scope: 'base', attributes: [ROLE] },
      userDn(uid)
    )) as { searchEntries: Record<string, unknown>[] };
    const value = searchEntries[0][ROLE] as string | string[] | undefined;
    return (value === undefined ? [] : [value].flat()).sort();
  };

  const expectRoles = async (uid: string, roles: string[]): Promise<void> => {
    const wanted = [...roles].sort();
    await waitFor(
      async () => JSON.stringify(await rolesOf(uid)) === JSON.stringify(wanted),
      { what: `${uid} holding ${wanted.join(', ')}` }
    ).catch(async err => {
      expect(await rolesOf(uid), String(err)).to.deep.equal(wanted);
    });
  };

  /** Hold back the following of changes until the returned call. */
  const hold = (): (() => void) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const queue = spaces as unknown as { following: Promise<void> };
    queue.following = queue.following.then(() => gate);
    return release;
  };

  const create = async (
    members: unknown[] = [{ username: 'tss-alice', role: 'admin' }],
    groups: unknown[] = []
  ): Promise<string> => {
    const res = await api
      .post(route)
      .send({ name: 'Design Sprint', members, groups })
      .expect(201);
    return res.body.id as string;
  };

  const group = async (name: string, usernames: string[]): Promise<string> => {
    const res = await api.post(groupRoute).send({ name }).expect(201);
    await api
      .post(`${groupRoute}/${res.body.id}/members`)
      .send({ usernames })
      .expect(200);
    return res.body.id as string;
  };

  before(async () => {
    dm = new DM();
    Object.assign(dm.config, {
      twake_group_base: `ou=groups,ou={org},${ORGS}`,
      twake_group_user_base: `ou=users,ou={org},${ORGS}`,
      twake_group_display_name_attribute: 'o',
      twake_group_color_attribute: 'businessCategory',
      twake_group_created_at_attribute: 'ou',
      twake_lifecycle_deleted_attribute: 'employeeType',
      twake_lifecycle_deleted_value: 'deleted',
      group_class: ['top', 'groupOfNames'],
      group_schema: 'static/schemas/twake/organizationGroups.json',
      twake_space_base: `ou=spaces,ou={org},${ORGS}`,
      twake_space_class: ['top', 'groupOfNames'],
      twake_space_display_name_attribute: 'O',
      twake_space_admin_attribute: 'member',
      twake_space_editor_attribute: 'owner',
      twake_space_viewer_attribute: 'seeAlso',
      twake_space_user_role_attribute: ROLE,
    });
    await dm.ready;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const groups = new TwakeGroups(dm);
    await dm.registerPlugin('core/twake/groups', groups);
    spaces = new TwakeSpaces(dm);
    await dm.registerPlugin('core/twake/spaces', spaces);
    for (let tries = 0; !groups.schema; tries++) {
      if (tries === 200) throw new Error('the group schema did not load');
      await new Promise(r => setTimeout(r, 10));
    }
    api = supertest(dm.app);
    for (const dn of [
      ORGS,
      orgDn,
      users,
      `ou=groups,${orgDn}`,
      `ou=spaces,${orgDn}`,
    ])
      await ou(dn);
  });

  beforeEach(async () => {
    for (const uid of UIDS)
      await dm.ldap
        .add(userDn(uid), {
          objectClass: [
            'top',
            'inetOrgPerson',
            'organizationalPerson',
            'person',
          ],
          cn: uid,
          sn: 'Doe',
          givenName: uid,
          uid,
          mail: `${uid}@acme.example.org`,
        })
        .catch(() => undefined);
  });

  afterEach(async () => {
    for (const branch of ['spaces', 'groups']) {
      const { searchEntries } = (await dm.ldap.search(
        { paged: false, scope: 'one', attributes: ['dn'] },
        `ou=${branch},${orgDn}`
      )) as { searchEntries: { dn: string }[] };
      for (const { dn } of searchEntries) await dm.ldap.delete(dn);
    }
    for (const uid of [...UIDS, 'tss-account'])
      await dm.ldap.delete(userDn(uid)).catch(() => undefined);
  });

  after(async () => {
    for (const dn of [
      users,
      `ou=groups,${orgDn}`,
      `ou=spaces,${orgDn}`,
      orgDn,
      ORGS,
    ])
      await dm.ldap.delete(dn).catch(() => undefined);
  });

  it('gives each user the highest of their own and their groups roles', async () => {
    const designers = await group('Designers', ['tss-bob', 'tss-carol']);
    const id = await create(
      [
        { username: 'tss-alice', role: 'admin' },
        { username: 'tss-bob', role: 'viewer' },
      ],
      [{ id: designers, role: 'editor' }]
    );
    await expectRoles('tss-alice', [`${id}:admin`]);
    await expectRoles('tss-bob', [`${id}:editor`]);
    await expectRoles('tss-carol', [`${id}:editor`]);
    await expectRoles('tss-dave', []);
  });

  it('follows the member writes and the deletion of the space', async () => {
    const first = await create();
    const second = await create();
    await expectRoles('tss-alice', [`${first}:admin`, `${second}:admin`]);
    await api
      .post(`${route}/${first}/members`)
      .send({ usernames: ['tss-bob'], role: 'viewer' })
      .expect(200);
    await expectRoles('tss-bob', [`${first}:viewer`]);
    await api
      .patch(`${route}/${first}/members/tss-bob`)
      .send({ role: 'editor' })
      .expect(200);
    await expectRoles('tss-bob', [`${first}:editor`]);
    await api.delete(`${route}/${first}/members/tss-bob`).expect(200);
    await expectRoles('tss-bob', []);
    await api.delete(`${route}/${first}`).expect(200);
    await expectRoles('tss-alice', [`${second}:admin`]);
  });

  it('follows the linked groups and their members', async () => {
    const designers = await group('Designers', ['tss-bob']);
    const id = await create();
    await api
      .post(`${route}/${id}/groups`)
      .send({ groupIds: [designers], role: 'viewer' })
      .expect(200);
    await expectRoles('tss-bob', [`${id}:viewer`]);
    await api
      .post(`${groupRoute}/${designers}/members`)
      .send({ usernames: ['tss-carol'] })
      .expect(200);
    await expectRoles('tss-carol', [`${id}:viewer`]);
    await api
      .patch(`${route}/${id}/groups/${designers}`)
      .send({ role: 'editor' })
      .expect(200);
    await expectRoles('tss-bob', [`${id}:editor`]);
    await expectRoles('tss-carol', [`${id}:editor`]);
    await api
      .delete(`${groupRoute}/${designers}/members/tss-carol`)
      .expect(200);
    await expectRoles('tss-carol', []);
    await api.delete(`${route}/${id}/groups/${designers}`).expect(200);
    await expectRoles('tss-bob', []);
  });

  it('drops the roles a deleted group gave', async () => {
    const designers = await group('Designers', ['tss-bob', 'tss-alice']);
    const id = await create(
      [{ username: 'tss-alice', role: 'admin' }],
      [{ id: designers, role: 'viewer' }]
    );
    await expectRoles('tss-bob', [`${id}:viewer`]);
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    await expectRoles('tss-bob', []);
    await expectRoles('tss-alice', [`${id}:admin`]);
  });

  it('drops a deleted group from its spaces as they are when it goes', async () => {
    const designers = await group('Designers', ['tss-bob']);
    const id = await create(
      [
        { username: 'tss-alice', role: 'admin' },
        { username: 'tss-bob', role: 'editor' },
      ],
      [{ id: designers, role: 'viewer' }]
    );
    await expectRoles('tss-bob', [`${id}:editor`]);
    await Promise.all([
      api.delete(`${route}/${id}/members/tss-bob`).expect(200),
      api.delete(`${groupRoute}/${designers}`).expect(200),
    ]);
    await expectRoles('tss-bob', []);
  });

  for (const order of ['leave, then unlink', 'unlink, then leave'])
    it(`revokes a role whose group is left and unlinked before either is followed (${order})`, async () => {
      const designers = await group('Designers', ['tss-bob', 'tss-dave']);
      const id = await create(undefined, [{ id: designers, role: 'editor' }]);
      await expectRoles('tss-bob', [`${id}:editor`]);
      const release = hold();
      const leave = (): supertest.Test =>
        api.delete(`${groupRoute}/${designers}/members/tss-bob`).expect(200);
      const unlink = (): supertest.Test =>
        api.delete(`${route}/${id}/groups/${designers}`).expect(200);
      for (const write of order.startsWith('leave')
        ? [leave, unlink]
        : [unlink, leave])
        await write();
      release();
      await expectRoles('tss-bob', []);
    });

  it('gives a role once when a group is linked and joined before either is followed', async () => {
    const designers = await group('Designers', ['tss-bob']);
    const id = await create();
    const release = hold();
    await api
      .post(`${route}/${id}/groups`)
      .send({ groupIds: [designers], role: 'viewer' })
      .expect(200);
    await api
      .post(`${groupRoute}/${designers}/members`)
      .send({ usernames: ['tss-carol'] })
      .expect(200);
    release();
    await expectRoles('tss-carol', [`${id}:viewer`]);
    await expectRoles('tss-bob', [`${id}:viewer`]);
  });

  it('drops the roles of a deleted group whose space is deleted before either is followed', async () => {
    const designers = await group('Designers', ['tss-bob']);
    const id = await create(undefined, [{ id: designers, role: 'viewer' }]);
    await expectRoles('tss-bob', [`${id}:viewer`]);
    const release = hold();
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    await api.delete(`${route}/${id}`).expect(200);
    release();
    await expectRoles('tss-bob', []);
    await expectRoles('tss-alice', []);
  });

  it('leaves a tombstone the values it held', async () => {
    const id = await create([
      { username: 'tss-alice', role: 'admin' },
      { username: 'tss-bob', role: 'editor' },
    ]);
    await expectRoles('tss-bob', [`${id}:editor`]);
    await dm.ldap.modify(userDn('tss-bob'), {
      add: { employeeType: 'deleted' },
    });
    await api.delete(`${route}/${id}`).expect(200);
    // alice is settled by the same follow as bob
    await expectRoles('tss-alice', []);
    expect(await rolesOf('tss-bob')).to.deep.equal([`${id}:editor`]);
  });

  it('settles the other users when one cannot be written', async () => {
    // An account entry cannot hold the role attribute
    await dm.ldap.add(userDn('tss-account'), {
      objectClass: ['top', 'account'],
      uid: 'tss-account',
    });
    const id = await create([
      { username: 'tss-account', role: 'admin' },
      { username: 'tss-alice', role: 'admin' },
      { username: 'tss-bob', role: 'editor' },
    ]);
    await expectRoles('tss-alice', [`${id}:admin`]);
    await expectRoles('tss-bob', [`${id}:editor`]);
  });

  it('refuses core/ldap/trash on the organization groups', () => {
    const plugin = new TwakeSpaces(dm);
    dm.loadedPlugins.trash = plugin;
    try {
      for (const watched of ['', ORGS, `ou=groups,${orgDn}`])
        expect(() => {
          dm.config.trash_watched_bases = watched;
          plugin.assertComposition();
        }, watched).to.throw(/core\/ldap\/trash/);
      dm.config.trash_watched_bases = users;
      expect(() => plugin.assertComposition()).not.to.throw();
    } finally {
      delete dm.loadedPlugins.trash;
      delete dm.config.trash_watched_bases;
    }
  });

  it("keeps a user's other values of the attribute", async () => {
    await dm.ldap.modify(userDn('tss-bob'), { add: { [ROLE]: 'unrelated' } });
    const id = await create([
      { username: 'tss-alice', role: 'admin' },
      { username: 'tss-bob', role: 'editor' },
    ]);
    await expectRoles('tss-bob', [`${id}:editor`, 'unrelated']);
    await api.delete(`${route}/${id}`).expect(200);
    await expectRoles('tss-bob', ['unrelated']);
  });
});
