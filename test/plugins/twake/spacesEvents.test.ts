import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import TwakeGroups from '../../../src/plugins/twake/groups';
import TwakeSpaces from '../../../src/plugins/twake/spaces';
import { waitFor } from '../../helpers/waitFor';

const ORGS = `ou=tse-orgs,${process.env.DM_LDAP_BASE}`;
const orgDn = `ou=acme,${ORGS}`;
const users = `ou=users,${orgDn}`;
const userDn = (uid: string): string => `uid=${uid},${users}`;
const UIDS = ['tse-alice', 'tse-bob', 'tse-carol'];

interface Published {
  exchange: string;
  routingKey: string;
  message: Record<string, unknown>;
}

class StubRabbitMq {
  name = 'rabbitmq';
  published: Published[] = [];
  isAvailable(): boolean {
    return true;
  }
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, unknown>
  ): Promise<void> {
    this.published.push({ exchange, routingKey, message });
  }
}

describe('Twake spaces: events', function () {
  let dm: DM;
  let api: supertest.Agent;
  let rabbit: StubRabbitMq;
  let spaces: TwakeSpaces;
  const route = `/api/v1/organizations/acme/spaces`;
  const groupRoute = `/api/v1/organizations/acme/groups`;
  const uuids = new Map<string, string>();

  const ou = (dn: string): Promise<unknown> =>
    dm.ldap
      .add(dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: /^ou=([^,]+)/.exec(dn)![1],
      })
      .catch(() => undefined);

  const member = (uid: string, role: string): Record<string, unknown> => ({
    uuid: uuids.get(uid),
    username: uid,
    email: `${uid}@acme.example.org`,
    firstName: uid,
    lastName: 'Doe',
    role,
  });

  /**
   * Wait for the changes made so far to be followed and their events
   * published: two changes followed late may announce a role twice.
   */
  const quiet = async (): Promise<void> => {
    const queues = spaces as unknown as {
      following: Promise<void>;
      publishing: Promise<void>;
    };
    let following: Promise<void>;
    do {
      await new Promise(r => setTimeout(r, 100));
      following = queues.following;
      await following;
      await queues.publishing;
    } while (following !== queues.following);
  };

  /** The events published once `count` have come, without timestamp and actor. */
  const events = async (
    count: number
  ): Promise<[string, Record<string, unknown>][]> => {
    await waitFor(() => rabbit.published.length >= count, {
      what: `${count} events, got ${rabbit.published.map(p => p.routingKey).join(', ')}`,
    });
    // Lets any extra event of the same writes land, so it fails the comparison
    await quiet();
    const out = rabbit.published.map(({ exchange, routingKey, message }) => {
      expect(exchange).to.equal('space');
      expect(message.timestamp).to.match(/^\d{4}-\d\d-\d\dT/);
      // No authentication here: the actor is there, unknown
      expect(message).to.have.property('actor', undefined);
      const { timestamp: _, actor: __, ...rest } = message;
      return [routingKey, rest] as [string, Record<string, unknown>];
    });
    rabbit.published = [];
    return out;
  };

  const create = async (
    members: unknown[] = [{ username: 'tse-alice', role: 'admin' }],
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
    await quiet();
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
      rabbitmq_url: 'amqp://stub',
    });
    await dm.ready;
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
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
    for (const uid of UIDS) {
      await dm.ldap.add(userDn(uid), {
        objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        cn: uid,
        sn: 'Doe',
        givenName: uid,
        uid,
        mail: `${uid}@acme.example.org`,
      });
      const { searchEntries } = (await dm.ldap.search(
        { paged: false, scope: 'base', attributes: ['entryUUID'] },
        userDn(uid)
      )) as { searchEntries: Record<string, string>[] };
      uuids.set(uid, searchEntries[0].entryUUID);
    }
    rabbit.published = [];
  });

  afterEach(async () => {
    for (const branch of ['spaces', 'groups']) {
      const { searchEntries } = (await dm.ldap.search(
        { paged: false, scope: 'one', attributes: ['dn'] },
        `ou=${branch},${orgDn}`
      )) as { searchEntries: { dn: string }[] };
      for (const { dn } of searchEntries) await dm.ldap.delete(dn);
    }
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

  it('publishes a created space with its resolved members and groups', async () => {
    const designers = await group('Designers', ['tse-bob', 'tse-carol']);
    rabbit.published = [];
    const id = await create(
      [
        { username: 'tse-alice', role: 'admin' },
        { username: 'tse-bob', role: 'editor' },
      ],
      [{ id: designers, role: 'viewer' }]
    );
    expect(await events(1)).to.deep.equal([
      [
        'twake.space.created',
        {
          organizationId: 'acme',
          id,
          name: 'Design Sprint',
          members: [
            member('tse-alice', 'admin'),
            member('tse-bob', 'editor'),
            member('tse-carol', 'viewer'),
          ],
          groups: [{ id: designers, name: 'Designers', role: 'viewer' }],
        },
      ],
    ]);
  });

  it('publishes a rename and a deletion', async () => {
    const id = await create();
    await events(1);
    await api.patch(`${route}/${id}`).send({ name: 'Retro' }).expect(200);
    expect(await events(1)).to.deep.equal([
      ['twake.space.updated', { organizationId: 'acme', id, name: 'Retro' }],
    ]);
    await api.delete(`${route}/${id}`).expect(200);
    expect(await events(1)).to.deep.equal([
      ['twake.space.deleted', { organizationId: 'acme', id }],
    ]);
  });

  it('publishes the member writes', async () => {
    const id = await create();
    await events(1);
    const at = { organizationId: 'acme', id };
    await api
      .post(`${route}/${id}/members`)
      .send({ usernames: ['tse-bob'], role: 'viewer' })
      .expect(200);
    expect(await events(1)).to.deep.equal([
      [
        'twake.space.member.added',
        { ...at, members: [member('tse-bob', 'viewer')] },
      ],
    ]);
    await api
      .patch(`${route}/${id}/members/tse-bob`)
      .send({ role: 'editor' })
      .expect(200);
    expect(await events(1)).to.deep.equal([
      [
        'twake.space.member.role.changed',
        { ...at, members: [member('tse-bob', 'editor')] },
      ],
    ]);
    await api.delete(`${route}/${id}/members/tse-bob`).expect(200);
    expect(await events(1)).to.deep.equal([
      [
        'twake.space.member.removed',
        { ...at, members: [member('tse-bob', 'editor')] },
      ],
    ]);
  });

  it('publishes the members a linked group brings and takes', async () => {
    const designers = await group('Designers', ['tse-alice', 'tse-bob']);
    const id = await create();
    await events(1);
    const at = { organizationId: 'acme', id };
    const linked = (role: string): Record<string, unknown>[] => [
      { id: designers, name: 'Designers', role },
    ];
    await api
      .post(`${route}/${id}/groups`)
      .send({ groupIds: [designers], role: 'viewer' })
      .expect(200);
    expect(await events(2)).to.deep.equal([
      ['twake.space.group.linked', { ...at, groups: linked('viewer') }],
      [
        'twake.space.member.added',
        { ...at, members: [member('tse-bob', 'viewer')] },
      ],
    ]);
    await api
      .patch(`${route}/${id}/groups/${designers}`)
      .send({ role: 'editor' })
      .expect(200);
    expect(await events(2)).to.deep.equal([
      ['twake.space.group.role.changed', { ...at, groups: linked('editor') }],
      [
        'twake.space.member.role.changed',
        { ...at, members: [member('tse-bob', 'editor')] },
      ],
    ]);
    await api
      .post(`${groupRoute}/${designers}/members`)
      .send({ usernames: ['tse-carol'] })
      .expect(200);
    expect(await events(1)).to.deep.equal([
      [
        'twake.space.member.added',
        { ...at, members: [member('tse-carol', 'editor')] },
      ],
    ]);
    await api
      .delete(`${groupRoute}/${designers}/members/tse-carol`)
      .expect(200);
    expect(await events(1)).to.deep.equal([
      [
        'twake.space.member.removed',
        { ...at, members: [member('tse-carol', 'editor')] },
      ],
    ]);
    await api.delete(`${route}/${id}/groups/${designers}`).expect(200);
    expect(await events(2)).to.deep.equal([
      ['twake.space.group.unlinked', { ...at, groups: linked('editor') }],
      [
        'twake.space.member.removed',
        { ...at, members: [member('tse-bob', 'editor')] },
      ],
    ]);
  });

  it('unlinks a deleted group from each of its spaces', async () => {
    const designers = await group('Designers', ['tse-bob']);
    const one = await create(
      [{ username: 'tse-alice', role: 'admin' }],
      [{ id: designers, role: 'viewer' }]
    );
    const two = await create(
      [{ username: 'tse-alice', role: 'admin' }],
      [{ id: designers, role: 'editor' }]
    );
    await events(2);
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    const published = await events(4);
    expect(published).to.have.length(4);
    for (const [id, role] of [
      [one, 'viewer'],
      [two, 'editor'],
    ])
      expect(published).to.deep.include.members([
        [
          'twake.space.group.unlinked',
          {
            organizationId: 'acme',
            id,
            groups: [{ id: designers, name: 'Designers', role }],
          },
        ],
        [
          'twake.space.member.removed',
          { organizationId: 'acme', id, members: [member('tse-bob', role)] },
        ],
      ]);
  });

  it('publishes nothing for a deleted member', async () => {
    const id = await create([
      { username: 'tse-alice', role: 'admin' },
      { username: 'tse-bob', role: 'editor' },
    ]);
    await events(1);
    await dm.ldap.modify(userDn('tse-bob'), {
      replace: { employeeType: 'deleted' },
    });
    await dm.ldap.modify(`cn=${id},ou=spaces,${orgDn}`, {
      delete: { owner: userDn('tse-bob') },
    });
    await new Promise(r => setTimeout(r, 300));
    expect(rabbit.published).to.deep.equal([]);
  });
});
