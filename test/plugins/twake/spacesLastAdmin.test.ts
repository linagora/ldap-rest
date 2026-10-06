import { expect } from 'chai';
import type { Request } from 'express';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import TwakeGroups from '../../../src/plugins/twake/groups';
import TwakeSpaces from '../../../src/plugins/twake/spaces';
import TwakeTombstone from '../../../src/plugins/twake/tombstone';
import { waitFor } from '../../helpers/waitFor';

const ORGS = `ou=tsl-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = `ou=acme,${ORGS}`;
const users = `ou=users,${orgDn}`;
const userDn = (uid: string): string => `uid=${uid},${users}`;
const UIDS = ['tsl-alice', 'tsl-bob', 'tsl-carol', 'tsl-dave'];

class StubRabbitMq {
  name = 'rabbitmq';
  published: { routingKey: string; message: Record<string, unknown> }[] = [];
  isAvailable(): boolean {
    return true;
  }
  async getRawClient(): Promise<object> {
    return {};
  }
  async publish(
    _exchange: string,
    routingKey: string,
    message: Record<string, unknown>
  ): Promise<void> {
    this.published.push({ routingKey, message });
  }
}

describe('Twake spaces: last admin deleted', function () {
  let dm: DM;
  let api: supertest.Agent;
  let rabbit: StubRabbitMq;
  const route = `/api/v1/organizations/acme/spaces`;

  const ou = (dn: string): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
      })
      .catch(() => undefined);

  const create = async (members: unknown[]): Promise<string> => {
    const res = await api
      .post(route)
      .send({ name: 'Design Sprint', members })
      .expect(201);
    return res.body.id as string;
  };

  const membersOf = async (id: string): Promise<unknown[] | undefined> => {
    const res = await api.get(`${route}/${id}`);
    if (res.status === 404) return undefined;
    // No refint here: a deleted user stays in its spaces
    return (res.body.members as { username: string }[]).filter(
      m => m.username !== 'tsl-alice'
    );
  };

  const expectMembers = async (
    id: string,
    members: unknown[] | undefined
  ): Promise<void> => {
    const wanted = JSON.stringify(members);
    await waitFor(async () => JSON.stringify(await membersOf(id)) === wanted, {
      what: `space members ${wanted}`,
    }).catch(async err => {
      expect(await membersOf(id), String(err)).to.deep.equal(members);
    });
  };

  const tombstone = (uid: string): Promise<unknown> =>
    dm.ldap.modify(userDn(uid), { replace: { employeeType: 'deleted' } });

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
      rabbitmq_url: 'amqp://stub',
    });
    await dm.ready;
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const groups = new TwakeGroups(dm);
    await dm.registerPlugin('core/twake/groups', groups);
    await dm.registerPlugin('core/twake/spaces', new TwakeSpaces(dm));
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
    rabbit.published = [];
  });

  afterEach(async () => {
    const { searchEntries } = (await dm.ldap.search(
      { paged: false, scope: 'one', attributes: ['dn'] },
      `ou=spaces,${orgDn}`
    )) as { searchEntries: { dn: string }[] };
    for (const { dn } of searchEntries) await dm.ldap.delete(dn);
    for (const uid of UIDS)
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

  it('promotes the editors when the last admin is deleted', async () => {
    const id = await create([
      { username: 'tsl-alice', role: 'admin' },
      { username: 'tsl-bob', role: 'editor' },
      { username: 'tsl-dave', role: 'editor' },
      { username: 'tsl-carol', role: 'viewer' },
    ]);
    await dm.ldap.delete(userDn('tsl-alice'));
    await expectMembers(id, [
      { username: 'tsl-bob', role: 'admin' },
      { username: 'tsl-dave', role: 'admin' },
      { username: 'tsl-carol', role: 'viewer' },
    ]);
    await waitFor(
      () =>
        rabbit.published.filter(
          p => p.routingKey === 'twake.space.member.role.changed'
        ).length === 2,
      { what: 'two member.role.changed events' }
    );
    const promoted = rabbit.published
      .filter(p => p.routingKey === 'twake.space.member.role.changed')
      .map(p => p.message.members as Record<string, unknown>[])
      .map(([m]) => [m.username, m.role])
      .sort();
    expect(promoted).to.deep.equal([
      ['tsl-bob', 'admin'],
      ['tsl-dave', 'admin'],
    ]);
  });

  it('promotes the viewers when there is no editor', async () => {
    const id = await create([
      { username: 'tsl-alice', role: 'admin' },
      { username: 'tsl-carol', role: 'viewer' },
    ]);
    await tombstone('tsl-alice');
    await expectMembers(id, [{ username: 'tsl-carol', role: 'admin' }]);
  });

  it('deletes a space left with no member', async () => {
    const id = await create([{ username: 'tsl-alice', role: 'admin' }]);
    await dm.ldap.delete(userDn('tsl-alice'));
    await expectMembers(id, undefined);
    await waitFor(
      () =>
        rabbit.published.some(
          p => p.routingKey === 'twake.space.deleted' && p.message.id === id
        ),
      { what: 'the space deleted event' }
    );
  });

  it('deletes a space whose users are gone, whatever groups it links', async () => {
    const group = await api
      .post('/api/v1/organizations/acme/groups')
      .send({ name: 'Designers' })
      .expect(201);
    const designers = group.body.id as string;
    await api
      .post(`/api/v1/organizations/acme/groups/${designers}/members`)
      .send({ usernames: ['tsl-bob'] })
      .expect(200);
    const res = await api
      .post(route)
      .send({
        name: 'Design Sprint',
        members: [{ username: 'tsl-alice', role: 'admin' }],
        groups: [{ id: designers, role: 'editor' }],
      })
      .expect(201);
    const id = res.body.id as string;
    await dm.ldap.delete(userDn('tsl-alice'));
    await expectMembers(id, undefined);
    await dm.ldap
      .delete(`cn=${designers},ou=groups,${orgDn}`)
      .catch(() => undefined);
  });

  it('carries who deleted the last admin', async () => {
    const promoted = await create([
      { username: 'tsl-alice', role: 'admin' },
      { username: 'tsl-bob', role: 'editor' },
    ]);
    const deleted = await create([{ username: 'tsl-alice', role: 'admin' }]);
    rabbit.published = [];
    const req = { user: 'jdoe', headers: {} } as unknown as Request;
    await dm.ldap.forRequest(req).delete(userDn('tsl-alice'));
    await expectMembers(deleted, undefined);
    await expectMembers(promoted, [{ username: 'tsl-bob', role: 'admin' }]);
    await waitFor(
      () =>
        ['twake.space.deleted', 'twake.space.member.role.changed'].every(key =>
          rabbit.published.some(p => p.routingKey === key)
        ),
      { what: 'the space deleted and member promoted events' }
    );
    expect(
      rabbit.published
        .filter(p =>
          ['twake.space.deleted', 'twake.space.member.role.changed'].includes(
            p.routingKey
          )
        )
        .map(p => [p.routingKey, p.message.id, p.message.actor])
        .sort()
    ).to.deep.equal([
      ['twake.space.deleted', deleted, 'jdoe'],
      ['twake.space.member.role.changed', promoted, 'jdoe'],
    ]);
  });

  it('hands a space over once when a tombstone is then erased', async () => {
    const id = await create([
      { username: 'tsl-alice', role: 'admin' },
      { username: 'tsl-bob', role: 'editor' },
    ]);
    await tombstone('tsl-alice');
    await expectMembers(id, [{ username: 'tsl-bob', role: 'admin' }]);
    await dm.ldap.delete(userDn('tsl-alice'));
    await new Promise(r => setTimeout(r, 300));
    await expectMembers(id, [{ username: 'tsl-bob', role: 'admin' }]);
    expect(
      rabbit.published.filter(
        p => p.routingKey === 'twake.space.member.role.changed'
      )
    ).to.have.length(1);
  });

  it('leaves a space that keeps an admin', async () => {
    const id = await create([
      { username: 'tsl-alice', role: 'admin' },
      { username: 'tsl-bob', role: 'admin' },
      { username: 'tsl-carol', role: 'editor' },
    ]);
    await tombstone('tsl-alice');
    await new Promise(r => setTimeout(r, 300));
    await expectMembers(id, [
      { username: 'tsl-bob', role: 'admin' },
      { username: 'tsl-carol', role: 'editor' },
    ]);
  });
});

describe('Twake spaces: last admin deleted, with core/twake/tombstone', function () {
  const orgs = `ou=tst-orgs,${process.env.DM_LDAP_BASE}`;
  const org = `ou=acme,${orgs}`;
  const people = `ou=users,${org}`;
  const person = (uid: string): string => `uid=${uid},${people}`;
  const route = `/api/v1/organizations/acme/spaces`;
  let dm: DM;
  // Loads no plugin: what it writes or deletes, nothing hears
  let raw: DM;
  let api: supertest.Agent;
  let tombstones: TwakeTombstone;

  const ou = (dn: string): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
      })
      .catch(() => undefined);

  const create = async (members: unknown[]): Promise<string> => {
    const res = await api
      .post(route)
      .send({ name: 'Design Sprint', members })
      .expect(201);
    return res.body.id as string;
  };

  const expectMembers = async (
    id: string,
    members: unknown[]
  ): Promise<void> => {
    // An erased admin may stay in the space without refint
    const read = async (): Promise<unknown> =>
      (
        (await api.get(`${route}/${id}`)).body.members as {
          username: string;
        }[]
      ).filter(m => m.username !== 'tst-alice');
    const wanted = JSON.stringify(members);
    await waitFor(async () => JSON.stringify(await read()) === wanted, {
      what: `space members ${wanted}`,
    }).catch(async err => {
      expect(await read(), String(err)).to.deep.equal(members);
    });
  };

  before(async () => {
    dm = new DM();
    Object.assign(dm.config, {
      twake_group_base: `ou=groups,ou={org},${orgs}`,
      twake_group_user_base: `ou=users,ou={org},${orgs}`,
      twake_group_display_name_attribute: 'o',
      twake_group_color_attribute: 'businessCategory',
      twake_group_created_at_attribute: 'ou',
      twake_lifecycle_deleted_attribute: 'employeeType',
      twake_lifecycle_deleted_value: 'deleted',
      twake_lifecycle_lock_attribute: 'carLicense',
      twake_lifecycle_lock_value: 'L',
      twake_tombstone_dn: [`^uid=[^,]+,ou=users,ou=[^,]+,${orgs}$`],
      group_class: ['top', 'groupOfNames'],
      group_schema: 'static/schemas/twake/organizationGroups.json',
      twake_space_base: `ou=spaces,ou={org},${orgs}`,
      twake_space_class: ['top', 'groupOfNames'],
      twake_space_display_name_attribute: 'O',
      twake_space_admin_attribute: 'member',
      twake_space_editor_attribute: 'owner',
      twake_space_viewer_attribute: 'seeAlso',
    });
    await dm.ready;
    raw = new DM();
    await raw.ready;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const groups = new TwakeGroups(dm);
    await dm.registerPlugin('core/twake/groups', groups);
    await dm.registerPlugin('core/twake/spaces', new TwakeSpaces(dm));
    tombstones = new TwakeTombstone(dm);
    await dm.registerPlugin('core/twake/tombstone', tombstones);
    tombstones.afterLoad();
    for (let tries = 0; !groups.schema; tries++) {
      if (tries === 200) throw new Error('the group schema did not load');
      await new Promise(r => setTimeout(r, 10));
    }
    api = supertest(dm.app);
    for (const dn of [
      orgs,
      org,
      people,
      `ou=groups,${org}`,
      `ou=spaces,${org}`,
    ])
      await ou(dn);
  });

  beforeEach(async () => {
    for (const uid of ['tst-alice', 'tst-bob'])
      await dm.ldap
        .add(person(uid), {
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
    const { searchEntries } = (await dm.ldap.search(
      { paged: false, scope: 'one', attributes: ['dn'] },
      `ou=spaces,${org}`
    )) as { searchEntries: { dn: string }[] };
    for (const { dn } of searchEntries) await dm.ldap.delete(dn);
    for (const uid of ['tst-alice', 'tst-bob'])
      await raw.ldap.delete(person(uid)).catch(() => undefined);
  });

  after(async () => {
    for (const dn of [
      people,
      `ou=groups,${org}`,
      `ou=spaces,${org}`,
      org,
      orgs,
    ])
      await raw.ldap.delete(dn).catch(() => undefined);
  });

  it('hands a space over when its last admin is deleted as a tombstone', async () => {
    const id = await create([
      { username: 'tst-alice', role: 'admin' },
      { username: 'tst-bob', role: 'editor' },
    ]);
    await dm.ldap.delete(person('tst-alice'));
    await expectMembers(id, [{ username: 'tst-bob', role: 'admin' }]);
  });

  it('hands a space over when a tombstone still its admin is erased', async () => {
    const id = await create([
      { username: 'tst-alice', role: 'admin' },
      { username: 'tst-bob', role: 'editor' },
    ]);
    // A tombstone written unheard: its hand-over never happened
    await raw.ldap.modify(person('tst-alice'), {
      replace: { employeeType: 'deleted', carLicense: 'L' },
    });
    await expectMembers(id, [{ username: 'tst-bob', role: 'editor' }]);
    await tombstones.erase(person('tst-alice'), { force: true });
    await expectMembers(id, [{ username: 'tst-bob', role: 'admin' }]);
  });
});
