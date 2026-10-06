import { expect } from 'chai';
import supertest from 'supertest';

import DmPlugin from '../../../src/abstract/plugin';
import { DM } from '../../../src/bin';
import type { Hooks } from '../../../src/hooks';
import TwakeGroups from '../../../src/plugins/twake/groups';
import TwakeSpaces from '../../../src/plugins/twake/spaces';

/** The bases of the searches made for a request. */
class ReadSpy extends DmPlugin {
  name = 'tspReadSpy';
  bases = new Set<string>();
  hooks: Hooks = {
    ldapsearchrequest: ([base, opts, req]) => {
      if (req) this.bases.add(base.toLowerCase());
      return [base, opts, req];
    },
  };
}

const ORGS = `ou=tsp-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = (org: string): string => `ou=${org},${ORGS}`;
const users = (org: string): string => `ou=users,${orgDn(org)}`;
const userDn = (uid: string, org = 'acme'): string =>
  `uid=${uid},${users(org)}`;

describe('Twake spaces plugin routes', function () {
  let dm: DM;
  let api: supertest.Agent;
  let spy: ReadSpy;
  const route = (org = 'acme'): string => `/api/v1/organizations/${org}/spaces`;
  const groupRoute = `/api/v1/organizations/acme/groups`;

  const ou = (dn: string, extra = {}): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
        ...extra,
      })
      .catch(() => undefined);

  const person = (dn: string, uid: string, extra = {}): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        cn: uid,
        sn: 'Doe',
        givenName: uid,
        uid,
        mail: `${uid}@acme.example.org`,
        ...extra,
      })
      .catch(() => undefined);

  const create = async (
    name = 'Design Sprint',
    members = [{ username: 'tsp-alice', role: 'admin' }],
    groups: unknown[] = []
  ): Promise<string> => {
    const res = await api
      .post(route())
      .send({ name, members, groups })
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
      twake_group_organization_dn: `ou={org},${ORGS}`,
      twake_group_organization_status_attribute: 'description',
      twake_group_display_name_attribute: 'o',
      twake_group_color_attribute: 'businessCategory',
      twake_group_created_at_attribute: 'ou',
      twake_lifecycle_deleted_attribute: 'employeeType',
      twake_lifecycle_deleted_value: 'deleted',
      group_class: ['top', 'groupOfNames'],
      group_schema: 'static/schemas/twake/organizationGroups.json',
      twake_space_base: `ou=spaces,ou={org},${ORGS}`,
      // Standard attributes, so the test needs no Twake schema, and none
      // required, as in twakeSpace: a space may be left without an admin
      twake_space_class: ['top', 'organizationalRole', 'extensibleObject'],
      twake_space_display_name_attribute: 'O',
      twake_space_admin_attribute: 'roleOccupant',
      twake_space_editor_attribute: 'owner',
      twake_space_viewer_attribute: 'seeAlso',
    });
    await dm.ready;
    const groups = new TwakeGroups(dm);
    await dm.registerPlugin('core/twake/groups', groups);
    await dm.registerPlugin('core/twake/spaces', new TwakeSpaces(dm));
    spy = new ReadSpy(dm);
    await dm.registerPlugin('tspReadSpy', spy);
    for (let tries = 0; !groups.schema; tries++) {
      if (tries === 200) throw new Error('the group schema did not load');
      await new Promise(r => setTimeout(r, 10));
    }
    api = supertest(dm.app);
    await ou(ORGS);
    for (const org of ['acme', 'other']) {
      await ou(orgDn(org));
      await ou(users(org));
      await ou(`ou=groups,${orgDn(org)}`);
      await ou(`ou=spaces,${orgDn(org)}`);
    }
    await ou(orgDn('gone'), { description: 'deleted' });
    for (const uid of ['tsp-alice', 'tsp-bob', 'tsp-carol'])
      await person(userDn(uid), uid);
    await person(userDn('tsp-gone'), 'tsp-gone', { employeeType: 'deleted' });
    await person(userDn('tsp-eve', 'other'), 'tsp-eve');
  });

  afterEach(async () => {
    for (const org of ['acme', 'other'])
      for (const branch of ['spaces', 'groups']) {
        const { searchEntries } = (await dm.ldap.search(
          { paged: false, scope: 'one', attributes: ['dn'] },
          `ou=${branch},${orgDn(org)}`
        )) as { searchEntries: { dn: string }[] };
        for (const { dn } of searchEntries) await dm.ldap.delete(dn);
      }
  });

  after(async () => {
    for (const uid of ['tsp-alice', 'tsp-bob', 'tsp-carol', 'tsp-gone'])
      await dm.ldap.delete(userDn(uid)).catch(() => undefined);
    await dm.ldap.delete(userDn('tsp-eve', 'other')).catch(() => undefined);
    for (const org of ['acme', 'other'])
      for (const dn of [
        users(org),
        `ou=groups,${orgDn(org)}`,
        `ou=spaces,${orgDn(org)}`,
        orgDn(org),
      ])
        await dm.ldap.delete(dn).catch(() => undefined);
    await dm.ldap.delete(orgDn('gone')).catch(() => undefined);
    await dm.ldap.delete(ORGS).catch(() => undefined);
  });

  it('refuses a space base without {org}', () => {
    const config = { ...dm.config, twake_space_base: 'ou=spaces,dc=x' };
    expect(() => new TwakeSpaces({ ...dm, config } as unknown as DM)).to.throw(
      '--twake-space-base must hold {org}'
    );
  });

  it('answers 404 for an unknown organization and 410 for a deleted one', async () => {
    const missing = await api.get(route('nowhere')).expect(404);
    expect(missing.body.code).to.equal('ORGANIZATION_NOT_FOUND');
    const gone = await api.post(route('gone')).send({}).expect(410);
    expect(gone.body.code).to.equal('ORGANIZATION_DELETED');
  });

  it('creates a space with a generated id, its members and groups', async () => {
    const designers = await group('Designers', ['tsp-carol']);
    const res = await api
      .post(route())
      .send({
        name: 'Design Sprint',
        members: [
          { username: 'tsp-alice', role: 'admin' },
          { username: 'tsp-bob', role: 'editor' },
        ],
        groups: [{ id: designers, role: 'viewer' }],
      })
      .expect(201);
    expect(res.body.id).to.match(/^[0-9a-f-]{36}$/);
    expect(res.body).to.deep.equal({
      id: res.body.id,
      name: 'Design Sprint',
      organizationId: 'acme',
      members: [
        { username: 'tsp-alice', role: 'admin' },
        { username: 'tsp-bob', role: 'editor' },
      ],
      groups: [{ id: designers, role: 'viewer' }],
    });
    const entry = (await dm.ldap.search(
      { paged: false, scope: 'base' },
      `cn=${res.body.id},ou=spaces,${orgDn('acme')}`
    )) as { searchEntries: Record<string, unknown>[] };
    expect(entry.searchEntries[0].o).to.equal('Design Sprint');
  });

  it('refuses an invalid space', async () => {
    const refuse = async (body: object, status = 400): Promise<string> =>
      (await api.post(route()).send(body).expect(status)).body.code as string;
    expect(await refuse({ name: ' ', members: [] })).to.equal('INVALID_INPUT');
    expect(
      await refuse({
        name: 'x',
        members: [{ username: 'tsp-bob', role: 'editor' }],
      })
    ).to.equal('ADMIN_REQUIRED');
    expect(
      await refuse({
        name: 'x',
        members: [{ username: 'tsp-alice', role: 'owner' }],
      })
    ).to.equal('INVALID_INPUT');
    expect(
      await refuse({
        name: 'x',
        members: [
          { username: 'tsp-alice', role: 'admin' },
          { username: 'TSP-ALICE', role: 'viewer' },
        ],
      })
    ).to.equal('INVALID_INPUT');
    for (const username of ['nobody', 'tsp-gone', 'tsp-eve'])
      expect(
        await refuse({ name: 'x', members: [{ username, role: 'admin' }] }, 404)
      ).to.equal('USER_NOT_FOUND');
    expect(
      await refuse(
        {
          name: 'x',
          members: [{ username: 'tsp-alice', role: 'admin' }],
          groups: [{ id: 'nope', role: 'viewer' }],
        },
        404
      )
    ).to.equal('GROUP_NOT_FOUND');
  });

  it('gets, renames and deletes a space', async () => {
    const id = await create();
    const got = await api.get(`${route()}/${id}`).expect(200);
    expect(got.body.name).to.equal('Design Sprint');
    expect((await api.get(`${route()}/nope`).expect(404)).body.code).to.equal(
      'SPACE_NOT_FOUND'
    );

    await api.patch(`${route()}/${id}`).send({ name: 'Retro' }).expect(200);
    expect((await api.get(`${route()}/${id}`)).body.name).to.equal('Retro');
    await api.patch(`${route()}/${id}`).send({ name: '' }).expect(400);
    await api.patch(`${route()}/${id}`).send({ color: '#fff' }).expect(400);
    expect(
      (await api.patch(`${route()}/nope`).send({ name: 'x' }).expect(404)).body
        .code
    ).to.equal('SPACE_NOT_FOUND');

    await api.delete(`${route()}/${id}`).expect(200);
    await api.get(`${route()}/${id}`).expect(404);
    await api.delete(`${route()}/${id}`).expect(404);
  });

  it('lists, searches and pages the spaces', async () => {
    await create('Alpha');
    await create('Beta');
    await create('Gamma');
    const all = await api.get(`${route()}?sortBy=name`).expect(200);
    expect(all.body.organizationId).to.equal('acme');
    expect(all.body.spaces.map((s: { name: string }) => s.name)).to.deep.equal([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect(all.body.pagination).to.deep.equal({
      page: 1,
      limit: 20,
      total: 3,
      totalPages: 1,
    });
    const found = await api.get(`${route()}?search=et`).expect(200);
    expect(
      found.body.spaces.map((s: { name: string }) => s.name)
    ).to.deep.equal(['Beta']);
    const paged = await api
      .get(`${route()}?sortBy=name&sortOrder=desc&limit=2&page=2`)
      .expect(200);
    expect(
      paged.body.spaces.map((s: { name: string }) => s.name)
    ).to.deep.equal(['Alpha']);
    await api.get(`${route()}?sortBy=color`).expect(400);
  });

  it('adds members with a role, changes it and removes them', async () => {
    const id = await create();
    const members = `${route()}/${id}/members`;
    await api
      .post(members)
      .send({ usernames: ['tsp-bob', 'tsp-carol'], role: 'viewer' })
      .expect(200);
    // The same role again changes nothing; another one is a conflict
    await api
      .post(members)
      .send({ usernames: ['tsp-bob'], role: 'viewer' })
      .expect(200);
    expect(
      (
        await api
          .post(members)
          .send({ usernames: ['tsp-bob'], role: 'editor' })
          .expect(409)
      ).body.code
    ).to.equal('MEMBER_EXISTS');

    await api.patch(`${members}/tsp-bob`).send({ role: 'editor' }).expect(200);
    const listed = await api.get(members).expect(200);
    expect(
      listed.body.members.map((m: { uid: string; role: string }) => [
        m.uid,
        m.role,
      ])
    ).to.deep.equal([
      ['tsp-alice', 'admin'],
      ['tsp-bob', 'editor'],
      ['tsp-carol', 'viewer'],
    ]);
    expect(listed.body.members[0].mail).to.equal('tsp-alice@acme.example.org');
    expect(listed.body.pagination.total).to.equal(3);

    await api.delete(`${members}/tsp-carol`).expect(200);
    expect(
      (await api.delete(`${members}/tsp-carol`).expect(404)).body.code
    ).to.equal('MEMBER_NOT_FOUND');
    expect(
      (
        await api
          .patch(`${members}/tsp-carol`)
          .send({ role: 'admin' })
          .expect(404)
      ).body.code
    ).to.equal('MEMBER_NOT_FOUND');
    expect((await api.get(`${route()}/${id}`)).body.members).to.deep.equal([
      { username: 'tsp-alice', role: 'admin' },
      { username: 'tsp-bob', role: 'editor' },
    ]);
  });

  it('refuses members of other organizations, tombstones and bad roles', async () => {
    const id = await create();
    const members = `${route()}/${id}/members`;
    for (const username of ['tsp-eve', 'tsp-gone', 'nobody'])
      expect(
        (
          await api
            .post(members)
            .send({ usernames: [username], role: 'viewer' })
            .expect(404)
        ).body.code
      ).to.equal('USER_NOT_FOUND');
    await api
      .post(members)
      .send({ usernames: ['tsp-bob'], role: 'boss' })
      .expect(400);
    await api.post(members).send({ usernames: [], role: 'viewer' }).expect(400);
    await api.patch(`${members}/tsp-alice`).send({ role: 'boss' }).expect(400);
    await api
      .post(`${route()}/nope/members`)
      .send({ usernames: ['tsp-bob'], role: 'viewer' })
      .expect(404);
  });

  it('keeps an admin in every space', async () => {
    const id = await create();
    const members = `${route()}/${id}/members`;
    for (const res of [
      await api.delete(`${members}/tsp-alice`).expect(409),
      await api
        .patch(`${members}/tsp-alice`)
        .send({ role: 'editor' })
        .expect(409),
    ])
      expect(res.body.code).to.equal('LAST_ADMIN');
    await api
      .post(members)
      .send({ usernames: ['tsp-bob'], role: 'admin' })
      .expect(200);
    await api
      .patch(`${members}/tsp-alice`)
      .send({ role: 'viewer' })
      .expect(200);
    await api.delete(`${members}/tsp-alice`).expect(200);
    expect((await api.get(`${route()}/${id}`)).body.members).to.deep.equal([
      { username: 'tsp-bob', role: 'admin' },
    ]);
  });

  it('keeps an admin when two are removed at once', async () => {
    const id = await create('Pair', [
      { username: 'tsp-alice', role: 'admin' },
      { username: 'tsp-bob', role: 'admin' },
    ]);
    const members = `${route()}/${id}/members`;
    const statuses = (
      await Promise.all([
        api.delete(`${members}/tsp-alice`),
        api.delete(`${members}/tsp-bob`),
      ])
    ).map(r => r.status);
    expect(statuses).to.include(409);
    const { body } = await api.get(`${route()}/${id}`);
    expect(
      body.members.filter((m: { role: string }) => m.role === 'admin')
    ).to.have.length.at.least(1);
  });

  it('reads a user held under two roles once, with the strongest, and moves both', async () => {
    const id = await create();
    const dn = `cn=${id},ou=spaces,${orgDn('acme')}`;
    const members = `${route()}/${id}/members`;
    const listed = async (): Promise<unknown> =>
      (await api.get(`${route()}/${id}`)).body.members;
    await dm.ldap.modify(dn, { add: { seeAlso: userDn('tsp-alice') } });
    expect(await listed()).to.deep.equal([
      { username: 'tsp-alice', role: 'admin' },
    ]);
    await api.delete(`${members}/tsp-alice`).expect(409);
    await api
      .post(members)
      .send({ usernames: ['tsp-bob'], role: 'admin' })
      .expect(200);
    await api
      .patch(`${members}/tsp-alice`)
      .send({ role: 'viewer' })
      .expect(200);
    await dm.ldap.modify(dn, { add: { owner: userDn('tsp-alice') } });
    expect(await listed()).to.deep.equal([
      { username: 'tsp-bob', role: 'admin' },
      { username: 'tsp-alice', role: 'editor' },
    ]);
    await api.delete(`${members}/tsp-alice`).expect(200);
    expect(await listed()).to.deep.equal([
      { username: 'tsp-bob', role: 'admin' },
    ]);
  });

  it('settles concurrent writes of one member', async () => {
    const id = await create();
    const members = `${route()}/${id}/members`;
    const twice = (send: () => supertest.Test): Promise<supertest.Response[]> =>
      Promise.all([send(), send()]);

    const added = await twice(() =>
      api.post(members).send({ usernames: ['tsp-bob'], role: 'viewer' })
    );
    expect(added.map(r => r.status)).to.deep.equal([200, 200]);

    const removed = await twice(() => api.delete(`${members}/tsp-bob`));
    expect(removed.map(r => r.status).sort()).to.deep.equal([200, 404]);
    expect(removed.find(r => r.status === 404)!.body.code).to.equal(
      'MEMBER_NOT_FOUND'
    );

    // Both may land, the user then held under two roles
    await Promise.all(
      ['admin', 'viewer'].map(role =>
        api.post(members).send({ usernames: ['tsp-bob'], role })
      )
    );
    await api.delete(`${members}/tsp-bob`).expect(200);
    expect((await api.get(`${route()}/${id}`)).body.members).to.deep.equal([
      { username: 'tsp-alice', role: 'admin' },
    ]);
  });

  it('caps the names of one request', async () => {
    const id = await create();
    const usernames = Array.from({ length: 1001 }, (_, i) => `u${i}`);
    await api
      .post(`${route()}/${id}/members`)
      .send({ usernames, role: 'viewer' })
      .expect(400);
  });

  it('hides tombstoned members', async () => {
    const id = await create();
    await dm.ldap.modify(`cn=${id},ou=spaces,${orgDn('acme')}`, {
      add: { owner: userDn('tsp-gone') },
    });
    expect((await api.get(`${route()}/${id}`)).body.members).to.deep.equal([
      { username: 'tsp-alice', role: 'admin' },
    ]);
    const listed = await api.get(`${route()}/${id}/members`).expect(200);
    expect(
      listed.body.members.map((m: { uid: string }) => m.uid)
    ).to.deep.equal(['tsp-alice']);
  });

  it('refuses a direct write of a user or group of another organization', async () => {
    const id = await create();
    const dn = `cn=${id},ou=spaces,${orgDn('acme')}`;
    for (const value of [
      userDn('tsp-eve', 'other'),
      `cn=x,ou=groups,${orgDn('other')}`,
      `cn=x,ou=elsewhere,${orgDn('acme')}`,
    ]) {
      let refused: Error | undefined;
      await dm.ldap
        .modify(dn, { add: { seeAlso: value } })
        .catch((err: Error) => (refused = err));
      expect(refused?.message, value).to.match(/neither a user nor a group/);
    }
    let created: Error | undefined;
    await dm.ldap
      .add(`cn=x,ou=spaces,${orgDn('acme')}`, {
        objectClass: ['top', 'organizationalRole'],
        cn: 'x',
        roleOccupant: userDn('tsp-eve', 'other'),
      })
      .catch((err: Error) => (created = err));
    expect(created?.message).to.match(/neither a user nor a group/);
  });

  it('links groups with a role, changes it and unlinks them', async () => {
    const designers = await group('Designers', ['tsp-bob']);
    const writers = await group('Writers', ['tsp-carol']);
    const id = await create();
    const linked = `${route()}/${id}/groups`;
    await api
      .post(linked)
      .send({ groupIds: [designers, writers], role: 'viewer' })
      .expect(200);
    await api
      .post(linked)
      .send({ groupIds: [designers], role: 'viewer' })
      .expect(200);
    expect(
      (
        await api
          .post(linked)
          .send({ groupIds: [designers], role: 'admin' })
          .expect(409)
      ).body.code
    ).to.equal('GROUP_ALREADY_LINKED');
    await api
      .patch(`${linked}/${writers}`)
      .send({ role: 'editor' })
      .expect(200);
    const listed = await api.get(linked).expect(200);
    expect(listed.body).to.deep.equal({
      organizationId: 'acme',
      id,
      groups: [
        { id: designers, name: 'Designers', role: 'viewer' },
        { id: writers, name: 'Writers', role: 'editor' },
      ],
    });

    await api.delete(`${linked}/${designers}`).expect(200);
    expect(
      (await api.delete(`${linked}/${designers}`).expect(404)).body.code
    ).to.equal('GROUP_NOT_FOUND');
    expect((await api.get(`${route()}/${id}`)).body.groups).to.deep.equal([
      { id: writers, role: 'editor' },
    ]);
    expect(
      (
        await api
          .post(linked)
          .send({ groupIds: ['nope'], role: 'viewer' })
          .expect(404)
      ).body.code
    ).to.equal('GROUP_NOT_FOUND');
  });

  it('reads with the request, for the authorization plugins to judge', async () => {
    const designers = await group('Designers', ['tsp-bob']);
    const id = await create(undefined, undefined, [
      { id: designers, role: 'viewer' },
    ]);
    spy.bases.clear();
    await api.get(`${route()}/${id}/members`).expect(200);
    await api.get(`${route()}/${id}/groups`).expect(200);
    await api.get(`${route()}?user=tsp-bob`).expect(200);
    expect([...spy.bases]).to.include.members(
      [
        `cn=${id},ou=spaces,${orgDn('acme')}`,
        `ou=spaces,${orgDn('acme')}`,
        `ou=groups,${orgDn('acme')}`,
        users('acme'),
      ].map(dn => dn.toLowerCase())
    );
  });

  it("lists a user's spaces with the highest of their roles", async () => {
    const designers = await group('Designers', ['tsp-bob']);
    const direct = await create('Direct', [
      { username: 'tsp-alice', role: 'admin' },
      { username: 'tsp-bob', role: 'viewer' },
    ]);
    const both = await create(
      'Both',
      [
        { username: 'tsp-alice', role: 'admin' },
        { username: 'tsp-bob', role: 'viewer' },
      ],
      [{ id: designers, role: 'editor' }]
    );
    const linked = await create(
      'Linked',
      [{ username: 'tsp-alice', role: 'admin' }],
      [{ id: designers, role: 'viewer' }]
    );
    await create('Elsewhere');
    const res = await api
      .get(`${route()}?user=tsp-bob&sortBy=name`)
      .expect(200);
    expect(
      res.body.spaces.map((s: { id: string; role: string }) => [s.id, s.role])
    ).to.deep.equal([
      [both, 'editor'],
      [direct, 'viewer'],
      [linked, 'viewer'],
    ]);
    expect(
      (await api.get(`${route()}?user=nobody`).expect(404)).body.code
    ).to.equal('USER_NOT_FOUND');
  });
});
