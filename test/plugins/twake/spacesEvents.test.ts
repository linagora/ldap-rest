import { expect } from 'chai';
import type { Request } from 'express';
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
const DOMAIN = 'acme.example.org';
// An attribute of organizationalUnit, so the test needs no Twake schema
const DOMAIN_ATTRIBUTE = 'description';
const betaDn = `ou=beta,${ORGS}`;
// A multi-valued attribute of inetOrgPerson, so the test needs no Twake schema
const ROLE = 'carLicense';

interface Published {
  exchange: string;
  routingKey: string;
  message: Record<string, unknown>;
  messageId?: string;
}

type Handler = (message: Record<string, unknown>) => Promise<void>;

class StubRabbitMq {
  name = 'rabbitmq';
  published: Published[] = [];
  client: object | null = {};
  subscribed: {
    exchange: string;
    routingKey: string;
    queue: string;
    handler: Handler;
    options?: { queueArguments?: Record<string, unknown> };
  }[] = [];
  async subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: Handler,
    options?: { queueArguments?: Record<string, unknown> }
  ): Promise<void> {
    this.subscribed.push({ exchange, routingKey, queue, handler, options });
  }
  isAvailable(): boolean {
    return true;
  }
  async getRawClient(): Promise<object | null> {
    return this.client;
  }
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, unknown>,
    options?: { messageId?: string }
  ): Promise<void> {
    // Silent without a client, like RabbitMq.publish
    if (!this.client) return;
    this.published.push({
      exchange,
      routingKey,
      message,
      messageId: options?.messageId,
    });
  }
}

/**
 * Without the role attribute, the roles a change moved are worked out with
 * it undone; with it, they are the values the user entry held.
 */
const suite = (role: string) => (): void => {
  let dm: DM;
  // Loads no plugin: what it writes, nothing hears
  let raw: DM;
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

  /** Hold back the following of changes until the returned call. */
  const hold = (): (() => void) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const queue = spaces as unknown as { following: Promise<void> };
    queue.following = queue.following.then(() => gate);
    return release;
  };

  /**
   * The events published once `count` have come, without timestamp, actor
   * and the domain of acme.
   */
  const events = async (
    count: number
  ): Promise<[string, Record<string, unknown>][]> => {
    await waitFor(() => rabbit.published.length >= count, {
      what: `${count} events, got ${rabbit.published.map(p => p.routingKey).join(', ')}`,
    });
    // Lets any extra event of the same writes land, so it fails the comparison
    await quiet();
    const out = rabbit.published.map(
      ({ exchange, routingKey, message, messageId }) => {
        expect(exchange).to.equal('space');
        expect(messageId).to.match(/^[0-9a-f-]{36}$/);
        expect(message.timestamp).to.match(/^\d{4}-\d\d-\d\dT/);
        // No authentication here: the actor is there, unknown
        expect(message).to.have.property('actor', undefined);
        const { timestamp: _, actor: __, ...rest } = message;
        if (rest.organizationId === 'acme') {
          expect(rest.organizationDomain).to.equal(DOMAIN);
          delete rest.organizationDomain;
        }
        return [routingKey, rest] as [string, Record<string, unknown>];
      }
    );
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
      twake_space_user_role_attribute: role,
      twake_group_organization_dn: `ou={org},${ORGS}`,
      twake_instance_organization_domain_attribute: DOMAIN_ATTRIBUTE,
      // An attribute of organizationalUnit
      twake_group_organization_status_attribute: 'st',
    });
    await dm.ready;
    raw = new DM();
    await raw.ready;
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
      betaDn,
      `ou=users,${betaDn}`,
      `ou=groups,${betaDn}`,
      `ou=spaces,${betaDn}`,
    ])
      await ou(dn);
    await dm.ldap.modify(orgDn, {
      replace: { [DOMAIN_ATTRIBUTE]: DOMAIN },
    });
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
      `ou=users,${betaDn}`,
      `ou=groups,${betaDn}`,
      `ou=spaces,${betaDn}`,
      betaDn,
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

  it('publishes no domain for an organization without one', async () => {
    const dan = `uid=tse-dan,ou=users,${betaDn}`;
    await dm.ldap.add(dan, {
      objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
      cn: 'tse-dan',
      sn: 'Doe',
      uid: 'tse-dan',
    });
    try {
      const res = await api
        .post('/api/v1/organizations/beta/spaces')
        .send({
          name: 'Beta',
          members: [{ username: 'tse-dan', role: 'admin' }],
        })
        .expect(201);
      const [[key, message]] = await events(1);
      expect(key).to.equal('twake.space.created');
      expect(message).to.include({ organizationId: 'beta', id: res.body.id });
      expect(message).not.to.have.property('organizationDomain');
      await api
        .delete(`/api/v1/organizations/beta/spaces/${res.body.id}`)
        .expect(200);
      await events(1);
    } finally {
      await dm.ldap.delete(dan).catch(() => undefined);
    }
  });

  it('follows a change of the organization domain', async () => {
    const id = await create();
    await events(1);
    await dm.ldap.modify(orgDn, {
      replace: { [DOMAIN_ATTRIBUTE]: 'acme.example.net' },
    });
    try {
      await api.patch(`${route}/${id}`).send({ name: 'Retro' }).expect(200);
      await quiet();
      expect(
        rabbit.published.map(p => p.message.organizationDomain)
      ).to.deep.equal(['acme.example.net']);
    } finally {
      rabbit.published = [];
      await dm.ldap.modify(orgDn, { replace: { [DOMAIN_ATTRIBUTE]: DOMAIN } });
      await quiet();
    }
  });

  it('refuses a domain attribute the schema does not define', async () => {
    dm.config.twake_instance_organization_domain_attribute =
      'tseNoSuchAttribute';
    try {
      const refused = await new TwakeSpaces(dm).assertComposition().then(
        () => undefined,
        (err: Error) => err
      );
      expect(refused?.message).to.match(/tseNoSuchAttribute/);
    } finally {
      dm.config.twake_instance_organization_domain_attribute = DOMAIN_ATTRIBUTE;
    }
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

  it('publishes nothing for a tombstoned member', async () => {
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
    await quiet();
    expect(rabbit.published).to.deep.equal([]);
  });

  it('publishes nothing for an erased member', async () => {
    // A viewer: refint does not watch seeAlso here, so the dead DN stays
    const id = await create([
      { username: 'tse-alice', role: 'admin' },
      { username: 'tse-bob', role: 'viewer' },
    ]);
    await events(1);
    await dm.ldap.delete(userDn('tse-bob'));
    await dm.ldap.modify(`cn=${id},ou=spaces,${orgDn}`, {
      delete: { seeAlso: userDn('tse-bob') },
    });
    await quiet();
    expect(rabbit.published).to.deep.equal([]);
  });

  it('unlinks a deleted group once, when its dead DN leaves later', async () => {
    const designers = await group('Designers', ['tse-bob']);
    const id = await create(undefined, [{ id: designers, role: 'viewer' }]);
    await events(1);
    const dn = `cn=${designers},ou=groups,${orgDn}`;
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    expect((await events(2)).map(([key]) => key)).to.have.members([
      'twake.space.group.unlinked',
      'twake.space.member.removed',
    ]);
    await dm.ldap.modify(`cn=${id},ou=spaces,${orgDn}`, {
      delete: { seeAlso: dn },
    });
    await quiet();
    expect(rabbit.published).to.deep.equal([]);
  });

  for (const outcome of ['lands', 'fails'])
    it(`unlinks a group once when its delete ${outcome} while the space is written`, async () => {
      const designers = await group('Designers', ['tse-bob']);
      const id = await create(undefined, [{ id: designers, role: 'viewer' }]);
      await events(1);
      let entered!: () => void;
      const reached = new Promise<void>(resolve => (entered = resolve));
      let resume!: () => void;
      const paused = new Promise<void>(resolve => (resume = resolve));
      // Holds the delete after core/twake/spaces has read it
      const pause = async (args: unknown[]): Promise<unknown[]> => {
        entered();
        await paused;
        if (outcome === 'fails') throw new Error('refused');
        return args;
      };
      const chain = (dm.hooks.ldapdeleterequest ||= []) as unknown[];
      chain.push(pause);
      try {
        const deleting = api.delete(`${groupRoute}/${designers}`).then(
          () => undefined,
          () => undefined
        );
        await reached;
        await api.delete(`${route}/${id}/groups/${designers}`).expect(200);
        await quiet();
        resume();
        await deleting;
      } finally {
        chain.splice(chain.indexOf(pause), 1);
      }
      await quiet();
      expect(
        rabbit.published
          .filter(p => p.routingKey === 'twake.space.group.unlinked')
          .map(p => p.message.id)
      ).to.deep.equal([id]);
      rabbit.published = [];
    });

  it('remembers a deleted group only in the spaces still holding it', async () => {
    const { announced } = spaces as unknown as {
      announced: Map<string, Set<string>>;
    };
    const remembered = (id: string): boolean =>
      [...announced.keys()].some(key => key.includes(id.toLowerCase()));
    const designers = await group('Designers', ['tse-bob']);
    // refint takes the group out of an editor, not of a viewer
    const kept = await create(undefined, [{ id: designers, role: 'viewer' }]);
    const left = await create(undefined, [{ id: designers, role: 'editor' }]);
    await events(2);
    const release = hold();
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    await waitFor(
      async () => {
        const { searchEntries } = (await dm.ldap.search(
          { paged: false, scope: 'base', attributes: ['owner'] },
          `cn=${left},ou=spaces,${orgDn}`
        )) as { searchEntries: { owner?: string[] }[] };
        return !searchEntries[0].owner?.length;
      },
      { what: 'refint to take the group out of the space' }
    );
    release();
    await events(4);
    expect([remembered(kept), remembered(left)]).to.deep.equal([true, false]);
    await api.delete(`${route}/${kept}`).expect(200);
    await events(1);
    expect(remembered(kept)).to.equal(false);
  });

  it('unlinks a group made again under the DN of one deleted', async () => {
    const designers = await group('Designers', ['tse-bob']);
    const id = await create(undefined, [{ id: designers, role: 'viewer' }]);
    await events(1);
    const dn = `cn=${designers},ou=groups,${orgDn}`;
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    await events(2);
    // Its dead DN leaves the space unheard, and a new group takes it
    await raw.ldap.modify(`cn=${id},ou=spaces,${orgDn}`, {
      delete: { seeAlso: dn },
    });
    await dm.ldap.add(dn, {
      objectClass: ['top', 'groupOfNames'],
      cn: designers,
      o: 'Designers',
      member: userDn('tse-carol'),
    });
    await api
      .post(`${route}/${id}/groups`)
      .send({ groupIds: [designers], role: 'viewer' })
      .expect(200);
    expect((await events(2)).map(([key]) => key)).to.deep.equal([
      'twake.space.group.linked',
      'twake.space.member.added',
    ]);
    await api.delete(`${route}/${id}/groups/${designers}`).expect(200);
    expect((await events(2)).map(([key]) => key)).to.deep.equal([
      'twake.space.group.unlinked',
      'twake.space.member.removed',
    ]);
  });

  it('announces a role two changes followed late moved once, with the role attribute', async function () {
    if (!role) return this.skip();
    const designers = await group('Designers', ['tse-bob']);
    const id = await create();
    await events(1);
    const release = hold();
    await api
      .post(`${route}/${id}/groups`)
      .send({ groupIds: [designers], role: 'viewer' })
      .expect(200);
    await api
      .post(`${groupRoute}/${designers}/members`)
      .send({ usernames: ['tse-carol'] })
      .expect(200);
    release();
    const at = { organizationId: 'acme', id };
    expect(await events(3)).to.deep.equal([
      [
        'twake.space.group.linked',
        {
          ...at,
          groups: [{ id: designers, name: 'Designers', role: 'viewer' }],
        },
      ],
      [
        'twake.space.member.added',
        { ...at, members: [member('tse-bob', 'viewer')] },
      ],
      [
        'twake.space.member.added',
        { ...at, members: [member('tse-carol', 'viewer')] },
      ],
    ]);
  });

  it('carries the actor of the write that moved a role, or none', async () => {
    const designers = await group('Designers', ['tse-carol']);
    const linked = await create(undefined, [{ id: designers, role: 'viewer' }]);
    const other = await create();
    await events(2);
    const as = (user: string): Request =>
      ({ user, headers: {} }) as unknown as Request;
    const release = hold();
    // alice makes carol an editor of a space through her group, while eve
    // adds carol to another one
    const designersDn = `cn=${designers},ou=groups,${orgDn}`;
    await dm.ldap
      .forRequest(as('alice'))
      .modify(`cn=${linked},ou=spaces,${orgDn}`, {
        delete: { seeAlso: designersDn },
        add: { owner: designersDn },
      });
    await dm.ldap
      .forRequest(as('eve'))
      .modify(`cn=${other},ou=spaces,${orgDn}`, {
        add: { seeAlso: userDn('tse-carol') },
      });
    release();
    await quiet();
    expect(
      rabbit.published.map(p => [p.routingKey, p.message.id, p.message.actor])
    ).to.deep.equal([
      ['twake.space.group.role.changed', linked, 'alice'],
      ['twake.space.member.role.changed', linked, 'alice'],
      // With the role attribute, alice's follow writes carol's role in the
      // other space first, and cannot say who gave it
      ['twake.space.member.added', other, role ? undefined : 'eve'],
    ]);
    rabbit.published = [];
  });

  it('unlinks a group unlinked, then deleted before the unlink is followed', async () => {
    const designers = await group('Designers', ['tse-bob']);
    const id = await create(undefined, [{ id: designers, role: 'viewer' }]);
    await events(1);
    const release = hold();
    await api.delete(`${route}/${id}/groups/${designers}`).expect(200);
    await api.delete(`${groupRoute}/${designers}`).expect(200);
    release();
    await quiet();
    expect(
      rabbit.published
        .filter(p => p.routingKey === 'twake.space.group.unlinked')
        .map(p => [p.message.id, p.message.groups])
    ).to.deep.equal([
      [id, [{ id: designers, name: designers, role: 'viewer' }]],
    ]);
    rabbit.published = [];
  });

  it('carries who made the write', async () => {
    const id = await create();
    await events(1);
    const req = { user: 'jdoe', headers: {} } as unknown as Request;
    await dm.ldap
      .forRequest(req)
      .modify(`cn=${id},ou=spaces,${orgDn}`, { replace: { O: 'Retro' } });
    await quiet();
    expect(
      rabbit.published.map(p => [p.routingKey, p.message.actor])
    ).to.deep.equal([['twake.space.updated', 'jdoe']]);
    rabbit.published = [];
  });

  it('refuses core/ldap/trash on the organization groups and spaces', async () => {
    const plugin = new TwakeSpaces(dm);
    dm.loadedPlugins.trash = plugin;
    try {
      for (const watched of ['', `ou=groups,${orgDn}`, `ou=spaces,${orgDn}`]) {
        dm.config.trash_watched_bases = watched;
        const refused = await plugin.assertComposition().then(
          () => undefined,
          (err: Error) => err
        );
        expect(refused?.message, watched).to.match(/core\/ldap\/trash/);
      }
      dm.config.trash_watched_bases = users;
      await plugin.assertComposition();
    } finally {
      delete dm.loadedPlugins.trash;
      delete dm.config.trash_watched_bases;
    }
  });

  it('logs the events a broker gone drops, and starts with no broker', async () => {
    const id = await create();
    await events(1);
    const failed: unknown[] = [];
    const { error } = spaces.logger;
    spaces.logger.error = ((m: unknown) => {
      failed.push(m);
      return spaces.logger;
    }) as typeof error;
    rabbit.client = null;
    try {
      await api.patch(`${route}/${id}`).send({ name: 'Retro' }).expect(200);
      await quiet();
      expect(failed).to.deep.include.members([
        {
          plugin: 'twakeSpaces',
          exchange: 'space',
          routingKey: 'twake.space.updated',
          messageId: (failed[0] as { messageId: string }).messageId,
          result: 'no broker',
        },
      ]);
      let refused: Error | undefined;
      await dm
        .registerPlugin('core/twake/spaces', new TwakeSpaces(dm), 'spacesLate')
        .catch((err: Error) => (refused = err));
      expect(refused?.message).to.match(/RabbitMQ at --rabbitmq-url cannot be/);
      expect(dm.loadedPlugins).not.to.have.property('spacesLate');
    } finally {
      rabbit.client = {};
      spaces.logger.error = error;
    }
  });

  describe('sync', () => {
    const SYNC = 'twake.space.sync.requested';
    const requested = { timestamp: '2026-10-07T02:00:00.000Z' };
    const handle = (message: unknown): Promise<void> =>
      rabbit.subscribed
        .filter(s => s.routingKey === SYNC)[0]
        .handler(message as Record<string, unknown>);
    const sync = (message: Record<string, unknown>): Promise<void> =>
      handle({ ...requested, ...message });
    const byUsername = (members: unknown): unknown =>
      (members as { username: string }[]).sort((a, b) =>
        a.username.localeCompare(b.username)
      );
    /** The events a sync published, with no actor, as `events` gives them. */
    const snapshot = async (): Promise<[string, Record<string, unknown>][]> => {
      await quiet();
      const out = rabbit.published.map(({ routingKey, message }) => {
        expect(message).not.to.have.property('actor');
        expect(message.timestamp).to.match(/^\d{4}-\d\d-\d\dT/);
        const { timestamp: _, ...rest } = message;
        if (rest.organizationId === 'acme') delete rest.organizationDomain;
        return [routingKey, rest] as [string, Record<string, unknown>];
      });
      rabbit.published = [];
      return out;
    };

    it('consumes sync requests from its own queue', () => {
      expect(
        rabbit.subscribed
          .filter(s => s.routingKey === SYNC)
          .map(({ handler: _, ...s }) => s)
      ).to.deep.equal([
        {
          exchange: 'space',
          routingKey: SYNC,
          queue: 'twake.space.sync.requested.ldap-rest',
          options: undefined,
        },
      ]);
    });

    it('publishes every space of an organization, then their ids', async () => {
      const designers = await group('Designers', ['tse-bob', 'tse-carol']);
      const design = await create(
        [
          { username: 'tse-alice', role: 'admin' },
          { username: 'tse-bob', role: 'editor' },
        ],
        [{ id: designers, role: 'viewer' }]
      );
      const retro = await create();
      await events(2);
      await sync({ organizationId: 'acme' });
      const published = rabbit.published;
      rabbit.published = [];
      expect(published.map(p => p.routingKey)).to.deep.equal([
        'twake.space.synced',
        'twake.space.synced',
        'twake.space.sync.completed',
      ]);
      const [timestamp] = published.map(p => p.message.timestamp);
      expect(timestamp).to.match(/^\d{4}-\d\d-\d\dT/);
      for (const { message } of published) {
        expect(message).to.include({
          organizationId: 'acme',
          organizationDomain: DOMAIN,
          timestamp,
        });
        expect(message).not.to.have.property('actor');
      }
      const synced = new Map(
        published
          .slice(0, 2)
          .map(({ message }) => [
            message.id as string,
            { ...message, members: byUsername(message.members) },
          ])
      );
      const common = { organizationId: 'acme', organizationDomain: DOMAIN };
      expect(synced.get(design)).to.deep.equal({
        ...common,
        id: design,
        name: 'Design Sprint',
        members: [
          member('tse-alice', 'admin'),
          member('tse-bob', 'editor'),
          member('tse-carol', 'viewer'),
        ],
        groups: [{ id: designers, name: 'Designers', role: 'viewer' }],
        timestamp,
      });
      expect(synced.get(retro)).to.deep.equal({
        ...common,
        id: retro,
        name: 'Design Sprint',
        members: [member('tse-alice', 'admin')],
        groups: [],
        timestamp,
      });
      const completed = published[2].message;
      expect((completed.spaceIds as string[]).sort()).to.deep.equal(
        [design, retro].sort()
      );
      expect(Object.keys(completed).sort()).to.deep.equal(
        ['organizationId', 'organizationDomain', 'spaceIds', 'timestamp'].sort()
      );
    });

    it('publishes one space, and a deletion for one gone', async () => {
      const id = await create();
      await create([{ username: 'tse-bob', role: 'admin' }]);
      await events(2);
      await sync({ organizationId: 'acme', id });
      expect(await snapshot()).to.deep.equal([
        [
          'twake.space.synced',
          {
            organizationId: 'acme',
            id,
            name: 'Design Sprint',
            members: [member('tse-alice', 'admin')],
            groups: [],
          },
        ],
      ]);
      const gone = '3b9e2c71-5d4a-4f0e-9c8b-1a2d6e7f8091';
      await sync({ organizationId: 'acme', id: gone });
      expect(await snapshot()).to.deep.equal([
        ['twake.space.deleted', { organizationId: 'acme', id: gone }],
      ]);
    });

    it('completes an organization with no space', async () => {
      await sync({ organizationId: 'beta' });
      expect(await snapshot()).to.deep.equal([
        [
          'twake.space.sync.completed',
          { organizationId: 'beta', spaceIds: [] },
        ],
      ]);
    });

    it('asks a sync of each organization for every organization', async () => {
      await sync({});
      const published = rabbit.published;
      rabbit.published = [];
      expect(published.every(p => p.routingKey === SYNC)).to.equal(true);
      expect(published.map(p => p.message.organizationId).sort()).to.deep.equal(
        ['acme', 'beta']
      );
      for (const { exchange, message, messageId } of published) {
        expect(exchange).to.equal('space');
        expect(message.timestamp).to.match(/^\d{4}-\d\d-\d\dT/);
        expect(messageId).to.match(/^[0-9a-f-]{36}$/);
      }
      expect(new Set(published.map(p => p.messageId)).size).to.equal(2);
    });

    it('fails a sync whose events the broker refuses, so it is retried', async () => {
      await create();
      await create([{ username: 'tse-bob', role: 'admin' }]);
      await events(2);
      const { publish } = rabbit;
      let refusals = 1;
      rabbit.publish = async (...args) => {
        if (args[1] === 'twake.space.synced' && refusals-- > 0)
          throw new Error('refused');
        return publish.apply(rabbit, args);
      };
      try {
        let refused: Error | undefined;
        await sync({ organizationId: 'acme' }).catch(
          (err: Error) => (refused = err)
        );
        expect(refused?.message).to.match(/refused/);
        rabbit.published = [];
        await sync({ organizationId: 'acme' });
        expect(rabbit.published.map(p => p.routingKey)).to.deep.equal([
          'twake.space.synced',
          'twake.space.synced',
          'twake.space.sync.completed',
        ]);
      } finally {
        rabbit.publish = publish;
        rabbit.published = [];
      }
    });

    it('lists no space for a deleted organization', async () => {
      const id = await create();
      await events(1);
      await dm.ldap.modify(orgDn, { replace: { st: 'deleted' } });
      try {
        await sync({ organizationId: 'acme' });
        expect(await snapshot()).to.deep.equal([
          [
            'twake.space.sync.completed',
            { organizationId: 'acme', spaceIds: [] },
          ],
        ]);
        await sync({ organizationId: 'acme', id });
        expect(await snapshot()).to.deep.equal([
          ['twake.space.deleted', { organizationId: 'acme', id }],
        ]);
      } finally {
        await dm.ldap.modify(orgDn, { delete: { st: 'deleted' } });
      }
    });

    it('skips a missing organization', async () => {
      await sync({ organizationId: 'tse-nowhere' });
      await quiet();
      expect(rabbit.published).to.deep.equal([]);
    });

    it('refuses a request it cannot read', async () => {
      for (const message of [
        [],
        'acme',
        null,
        { id: 'x' },
        { organizationId: 42 },
        { organizationId: 'acme', id: '' },
      ]) {
        let refused: Error | undefined;
        await handle(message).catch((err: Error) => (refused = err));
        expect(refused?.message, JSON.stringify(message)).to.match(
          /sync request/
        );
      }
      expect(rabbit.published).to.deep.equal([]);
    });
  });
};

describe('Twake spaces: events', suite(''));
describe('Twake spaces: events, with the user role attribute', suite(ROLE));
