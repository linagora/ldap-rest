import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import type { Request } from 'express';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import Scim from '../../../src/plugins/scim/scim';
import TwakeLifecycleEvents, {
  parseRules,
} from '../../../src/plugins/twake/lifecycleEvents';
import {
  lifecycleAttributes,
  parseDeletedAt,
} from '../../../src/plugins/twake/lifecycleAttributes';
import { waitFor } from '../../helpers/waitFor';

const BASE = `ou=users,${process.env.DM_LDAP_BASE}`;
const GROUPS = `ou=groups,${process.env.DM_LDAP_BASE}`;
const MEMBER = {
  username: '$uid',
  email: '$mail',
  lastName: '$sn',
  kind: 'person',
};
const LOCKED = '000001010000Z';
// What slapd writes on a ppolicy lockout
const LOCKOUT = '20260102030405Z';

interface Published {
  exchange: string;
  routingKey: string;
  message: Record<string, string>;
  messageId?: string;
}

class StubRabbitMq {
  name = 'rabbitmq';
  published: Published[] = [];
  /** A routing key whose publish throws */
  failOn = '';
  client: object | null = {};
  async getRawClient(): Promise<object | null> {
    return this.client;
  }
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, string>,
    options?: { messageId?: string }
  ): Promise<void> {
    // Silent without a client, like RabbitMq.publish
    if (!this.client) return;
    if (routingKey === this.failOn) throw new Error('broker down');
    this.published.push({
      exchange,
      routingKey,
      message,
      messageId: options?.messageId,
    });
  }
}

const RULES = [
  {
    dn: `^cn=(?<id>lcg-[^,]+),${GROUPS}$`,
    exchange: 'groups',
    events: {
      created: {
        routingKey: 'group.created',
        payload: {
          id: '$dn.id',
          name: '$description',
          members: { $members: MEMBER },
        },
      },
      updated: {
        routingKey: 'group.updated',
        payload: {
          id: '$dn.id',
          name: '$changed.description',
          color: '$changed.businessCategory',
        },
      },
      memberAdded: {
        routingKey: 'group.member.added',
        payload: { id: '$dn.id', members: { $added: MEMBER } },
      },
      memberRemoved: {
        routingKey: 'group.member.removed',
        payload: { id: '$dn.id', members: { $removed: MEMBER } },
      },
      deleted: { routingKey: 'group.deleted', payload: { id: '$dn.id' } },
    },
  },
  {
    dn: `^uid=(?<id>lc-[^,]+),${BASE}$`,
    exchange: 'accounts',
    payload: {
      id: '$dn.id',
      email: '$mail',
      role: '$title',
      domain: '$mail|domain',
      kind: 'account',
      actor: '$context.actor',
      requestId: '$context.requestId',
      source: '$context.source',
    },
    events: {
      created: 'account.created',
      roleChanged: {
        routingKey: 'account.role.changed',
        payload: {
          id: '$dn.id',
          role: '$title',
          previousRole: '$previous.title',
        },
      },
      disabled: 'account.disabled',
      enabled: 'account.enabled',
      deleted: [
        {
          routingKey: 'account.deleted',
          payload: {
            id: '$dn.id',
            email: '$mail',
            reasonCode: '$businessCategory',
            deletedAt: '$roomNumber',
          },
        },
        {
          routingKey: 'account.deleted.notify',
          exchange: 'notifications',
          when: { $businessCategory: 'user_request' },
          payload: { id: '$dn.id', mobile: '$previous.mobile' },
        },
      ],
    },
  },
  {
    dn: `^uid=(?<id>[^,]+),ou=(?<org>lc-[^,]+),${BASE}$`,
    exchange: 'accounts',
    payload: { id: '$dn.id', org: '$dn.org' },
    events: { created: 'member.created' },
  },
  {
    dn: `^uid=(?<id>neg-[^,]+),${BASE}$`,
    exchange: 'accounts',
    payload: { id: '$dn.id' },
    events: {
      created: [
        { routingKey: 'admin.created', when: { $title: 'admin' } },
        { routingKey: 'other.created', when: { $title: '!admin' } },
      ],
    },
  },
];

describe('Twake lifecycle events plugin', function () {
  let dm: DM;
  let rabbit: StubRabbitMq;
  let plugin: TwakeLifecycleEvents;
  let handled: { dn: string; done: Promise<unknown> }[] = [];

  const dnOf = (name: string): string => `uid=${name},${BASE}`;

  /**
   * Wait until the plugin has handled `count` changes of `dn` since the test
   * began, and finished publishing for them.
   */
  async function seen(dn: string, count = 1): Promise<void> {
    const mine = (): typeof handled =>
      handled.filter(h => h.dn.toLowerCase() === dn.toLowerCase());
    await waitFor(() => mine().length >= count, {
      what: `${count} change(s) of ${dn}`,
    });
    await Promise.all(mine().map(h => h.done));
  }

  async function add(
    name: string,
    extra: Record<string, string | string[]> = {}
  ): Promise<void> {
    await dm.ldap.add(dnOf(name), {
      objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
      cn: name,
      sn: name,
      uid: name,
      mail: `${name}@example.org`,
      ...extra,
    });
  }

  function keys(): string[] {
    return rabbit.published.map(p => p.routingKey);
  }

  before(async () => {
    dm = new DM();
    dm.config.twake_lifecycle_role_attribute = 'title';
    dm.config.twake_lifecycle_lock_attribute = 'pwdAccountLockedTime';
    dm.config.twake_lifecycle_deleted_attribute = 'employeeType';
    dm.config.twake_lifecycle_deleted_value = 'deleted';
    dm.config.twake_lifecycle_deleted_at_attribute = 'roomNumber';
    dm.config.twake_lifecycle_rules = JSON.stringify(RULES);
    dm.config.rabbitmq_url = 'amqp://stub';
    await dm.ready;
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    plugin = new TwakeLifecycleEvents(dm);
    const hook = plugin.hooks.onLdapEntryChange!;
    plugin.hooks.onLdapEntryChange = (dn, ...rest) => {
      const done = Promise.resolve(hook(dn, ...rest));
      handled.push({ dn, done });
      return done;
    };
    await dm.registerPlugin('core/twake/lifecycleEvents', plugin);
  });

  beforeEach(() => {
    rabbit.published = [];
    rabbit.failOn = '';
    rabbit.client = {};
    handled = [];
  });

  afterEach(async () => {
    rabbit.failOn = '';
    rabbit.client = {};
    for (const name of [
      'lc-alice',
      'lc-bob',
      'lc-a\\,b',
      'other-carol',
      'neg-admin',
      'neg-member',
      'neg-none',
    ]) {
      await dm.ldap.delete(dnOf(name)).catch(() => undefined);
    }
  });

  it('publishes created with the configured payload', async () => {
    await add('lc-alice', { title: 'member' });
    await seen(dnOf('lc-alice'));
    expect(rabbit.published).to.have.length(1);
    const [p] = rabbit.published;
    expect(p.exchange).to.equal('accounts');
    expect(p.routingKey).to.equal('account.created');
    expect(p.message).to.deep.equal({
      id: 'lc-alice',
      email: 'lc-alice@example.org',
      role: 'member',
      domain: 'example.org',
      kind: 'account',
    });
    expect(p.messageId).to.match(/^[0-9a-f-]{36}$/);
  });

  it('carries who wrote the entry, and through which door', async () => {
    const req = { user: 'jdoe', headers: {} } as unknown as Request;
    await dm.ldap.forRequest(req).add(dnOf('lc-alice'), {
      objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
      cn: 'lc-alice',
      sn: 'lc-alice',
      uid: 'lc-alice',
    });
    await seen(dnOf('lc-alice'));
    expect(rabbit.published[0].message).to.include({
      actor: 'jdoe',
      source: 'rest',
    });
    expect(rabbit.published[0].message.requestId).to.match(/^[0-9a-f-]{36}$/);
  });

  it('publishes a target whose condition is negated only when it differs', async () => {
    await add('neg-admin', { title: 'admin' });
    await seen(dnOf('neg-admin'));
    await add('neg-member', { title: 'member' });
    await seen(dnOf('neg-member'));
    await add('neg-none');
    await seen(dnOf('neg-none'));
    expect(
      rabbit.published.map(p => [p.routingKey, p.message.id])
    ).to.deep.equal([
      ['admin.created', 'neg-admin'],
      ['other.created', 'neg-member'],
      ['other.created', 'neg-none'],
    ]);
  });

  it('publishes nothing for a rename', async () => {
    await add('lc-alice', { title: 'member' });
    await seen(dnOf('lc-alice'));
    rabbit.published = [];
    await dm.ldap.rename(dnOf('lc-alice'), dnOf('lc-bob'));
    await seen(dnOf('lc-bob'));
    expect(rabbit.published).to.deep.equal([]);
  });

  it("publishes nothing for a move into another rule's pattern", async () => {
    const org = `ou=lc-org,${BASE}`;
    const moved = `uid=lc-alice,${org}`;
    await dm.ldap.add(org, {
      objectClass: ['top', 'organizationalUnit'],
      ou: 'lc-org',
    });
    try {
      await add('lc-alice');
      await seen(dnOf('lc-alice'));
      rabbit.published = [];
      await dm.ldap.rename(dnOf('lc-alice'), moved);
      await seen(moved);
      expect(rabbit.published).to.deep.equal([]);
    } finally {
      await dm.ldap.delete(moved).catch(() => undefined);
      await dm.ldap.delete(org).catch(() => undefined);
    }
  });

  it('publishes created then disabled for a SCIM create with active false', async () => {
    dm.config.scim_user_base = BASE;
    dm.config.scim_user_lock_attribute = 'pwdAccountLockedTime';
    dm.config.scim_user_lock_value = LOCKED;
    await dm.registerPlugin('core/scim', new Scim(dm));
    const res = await supertest(dm.app)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'lc-alice',
        name: { familyName: 'lc-alice' },
        active: false,
      });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    await seen(dnOf('lc-alice'));
    expect(keys()).to.deep.equal(['account.created', 'account.disabled']);
    expect(rabbit.published[0].message.source).to.equal('scim');
  });

  it('publishes for an entry nested under a branch of its own', async () => {
    const org = `ou=lc-org,${BASE}`;
    const dn = `uid=dave,${org}`;
    await dm.ldap.add(org, {
      objectClass: ['top', 'organizationalUnit'],
      ou: 'lc-org',
    });
    try {
      await dm.ldap.add(dn, {
        objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        cn: 'dave',
        sn: 'dave',
        uid: 'dave',
      });
      await seen(dn);
      expect(
        rabbit.published.map(p => [p.routingKey, p.message])
      ).to.deep.equal([['member.created', { id: 'dave', org: 'lc-org' }]]);
    } finally {
      await dm.ldap.delete(dn).catch(() => undefined);
      await dm.ldap.delete(org).catch(() => undefined);
    }
  });

  it('matches a DN spelled with spaces', async () => {
    const spaced = `uid=lc-alice, ${BASE.replace(/,/g, ' , ')}`;
    await dm.ldap.add(spaced, {
      objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
      cn: 'lc-alice',
      sn: 'lc-alice',
      uid: 'lc-alice',
    });
    await seen(spaced);
    expect(keys()).to.deep.equal(['account.created']);
    expect(rabbit.published[0].message.id).to.equal('lc-alice');
  });

  it('takes an escaped comma into the id', async () => {
    await add('lc-a\\,b', { uid: 'lc-a,b' });
    await seen(dnOf('lc-a\\,b'));
    expect(rabbit.published[0].message.id).to.equal('lc-a,b');
  });

  it('publishes nothing for an entry no rule matches', async () => {
    await add('other-carol');
    await dm.ldap.modify(dnOf('other-carol'), { replace: { title: 'admin' } });
    await seen(dnOf('other-carol'), 2);
    expect(rabbit.published).to.deep.equal([]);
  });

  it('publishes roleChanged with the previous role, once per real change', async () => {
    await add('lc-alice', { title: 'member' });
    await seen(dnOf('lc-alice'));
    rabbit.published = [];
    await dm.ldap.modify(dnOf('lc-alice'), { replace: { title: 'admin' } });
    // Resending the same role changes nothing, so nothing is published
    await dm.ldap.modify(dnOf('lc-alice'), { replace: { title: 'admin' } });
    await dm.ldap.modify(dnOf('lc-alice'), {
      replace: { mail: 'alice@example.org' },
    });
    await seen(dnOf('lc-alice'), 3);
    expect(rabbit.published.map(p => [p.routingKey, p.message])).to.deep.equal([
      [
        'account.role.changed',
        { id: 'lc-alice', role: 'admin', previousRole: 'member' },
      ],
    ]);
  });

  it('publishes no roleChanged when only the case of the role changes', async () => {
    await add('lc-alice', { title: 'member' });
    await seen(dnOf('lc-alice'));
    rabbit.published = [];
    await dm.ldap.modify(dnOf('lc-alice'), { replace: { title: 'Member' } });
    await seen(dnOf('lc-alice'), 2);
    expect(rabbit.published).to.deep.equal([]);
  });

  it('publishes disabled and enabled when an operational lock is set and cleared', async () => {
    await add('lc-alice');
    await dm.ldap.modify(dnOf('lc-alice'), {
      replace: { pwdAccountLockedTime: LOCKED },
    });
    await seen(dnOf('lc-alice'), 2);
    await dm.ldap.modify(dnOf('lc-alice'), {
      delete: ['pwdAccountLockedTime'],
    });
    await seen(dnOf('lc-alice'), 3);
    expect(keys()).to.deep.equal([
      'account.created',
      'account.disabled',
      'account.enabled',
    ]);
  });

  it('publishes created then disabled for an entry added locked', async () => {
    await add('lc-alice', { pwdAccountLockedTime: LOCKED });
    await seen(dnOf('lc-alice'));
    expect(keys()).to.deep.equal(['account.created', 'account.disabled']);
  });

  it('publishes only created for an entry added with a lockout timestamp', async () => {
    await add('lc-alice', { pwdAccountLockedTime: LOCKOUT });
    await seen(dnOf('lc-alice'));
    expect(keys()).to.deep.equal(['account.created']);
  });

  it('takes a lockout timestamp for no lock, and the lock value for one', async () => {
    await add('lc-alice');
    const lock = (value: string): Promise<boolean> =>
      dm.ldap.modify(dnOf('lc-alice'), {
        replace: { pwdAccountLockedTime: value },
      });
    await lock(LOCKOUT);
    await lock(LOCKED);
    await lock(LOCKOUT);
    await dm.ldap.modify(dnOf('lc-alice'), {
      delete: ['pwdAccountLockedTime'],
    });
    await seen(dnOf('lc-alice'), 5);
    expect(keys()).to.deep.equal([
      'account.created',
      'account.disabled',
      'account.enabled',
    ]);
  });

  describe('deletion', () => {
    const deletedAt = '2026-01-02T03:04:05.000Z';

    async function tombstone(reason = 'member_deleted'): Promise<void> {
      await dm.ldap.modify(dnOf('lc-alice'), {
        replace: {
          employeeType: 'deleted',
          roomNumber: deletedAt,
          businessCategory: reason,
          pwdAccountLockedTime: LOCKED,
        },
        delete: ['mobile'],
      });
    }

    beforeEach(async () => {
      await add('lc-alice', { mobile: '+33600000000' });
      await seen(dnOf('lc-alice'));
      rabbit.published = [];
    });

    it('publishes deleted, and not disabled, when the entry becomes a tombstone', async () => {
      await tombstone();
      await seen(dnOf('lc-alice'), 2);
      expect(
        rabbit.published.map(p => [p.routingKey, p.message])
      ).to.deep.equal([
        [
          'account.deleted',
          {
            id: 'lc-alice',
            email: 'lc-alice@example.org',
            reasonCode: 'member_deleted',
            deletedAt,
          },
        ],
      ]);
    });

    it('publishes deleted and not disabled when the lock follows in a second write', async () => {
      await dm.ldap.modify(dnOf('lc-alice'), {
        replace: { employeeType: 'deleted', roomNumber: deletedAt },
      });
      await dm.ldap.modify(dnOf('lc-alice'), {
        replace: { pwdAccountLockedTime: LOCKED },
      });
      await seen(dnOf('lc-alice'), 3);
      expect(keys()).to.deep.equal(['account.deleted']);
    });

    it('publishes a target only when its condition holds', async () => {
      await tombstone('user_request');
      await seen(dnOf('lc-alice'), 2);
      expect(
        rabbit.published.map(p => [p.exchange, p.routingKey, p.message])
      ).to.deep.include([
        'notifications',
        'account.deleted.notify',
        { id: 'lc-alice', mobile: '+33600000000' },
      ]);
    });

    it('publishes nothing for other changes to a tombstone', async () => {
      await tombstone();
      await seen(dnOf('lc-alice'), 2);
      rabbit.published = [];
      await dm.ldap.modify(dnOf('lc-alice'), {
        delete: ['pwdAccountLockedTime'],
        replace: { title: 'admin' },
      });
      await seen(dnOf('lc-alice'), 3);
      expect(rabbit.published).to.deep.equal([]);
    });

    it('publishes nothing for a restore, and publishes again afterwards', async () => {
      await tombstone();
      await seen(dnOf('lc-alice'), 2);
      rabbit.published = [];
      await dm.ldap.modify(dnOf('lc-alice'), {
        delete: ['employeeType', 'pwdAccountLockedTime'],
      });
      await seen(dnOf('lc-alice'), 3);
      expect(rabbit.published).to.deep.equal([]);
      await dm.ldap.modify(dnOf('lc-alice'), {
        replace: { pwdAccountLockedTime: LOCKED },
      });
      await seen(dnOf('lc-alice'), 4);
      expect(keys()).to.deep.equal(['account.disabled']);
    });

    it('publishes nothing when a tombstone is removed', async () => {
      await tombstone();
      await seen(dnOf('lc-alice'), 2);
      rabbit.published = [];
      await dm.ldap.delete(dnOf('lc-alice'));
      await seen(dnOf('lc-alice'), 3);
      expect(rabbit.published).to.deep.equal([]);
    });

    it('publishes deleted when a live entry is removed', async () => {
      await dm.ldap.delete(dnOf('lc-alice'));
      await seen(dnOf('lc-alice'), 2);
      expect(
        rabbit.published.map(p => [p.routingKey, p.message])
      ).to.deep.equal([
        ['account.deleted', { id: 'lc-alice', email: 'lc-alice@example.org' }],
      ]);
    });
  });

  /** What this plugin logged while `write` ran. */
  async function logsOf(
    write: () => Promise<void>
  ): Promise<{ level: string; entry: Record<string, unknown> }[]> {
    const logged: { level: string; entry: Record<string, unknown> }[] = [];
    const logger = dm.logger;
    const { error, info } = logger;
    const capture =
      (level: string) =>
      (entry: Record<string, unknown>): typeof logger => {
        logged.push({ level, entry });
        return logger;
      };
    logger.error = capture('error') as typeof logger.error;
    logger.info = capture('info') as typeof logger.info;
    try {
      await write();
    } finally {
      logger.error = error;
      logger.info = info;
    }
    return logged.filter(
      l => (l.entry as { plugin?: string })?.plugin === 'twakeLifecycleEvents'
    );
  }

  it('logs a failed publish, publishes the next targets, and lets the write succeed', async () => {
    await add('lc-alice', { businessCategory: 'user_request' });
    await seen(dnOf('lc-alice'));
    rabbit.published = [];
    rabbit.failOn = 'account.deleted';
    const logs = await logsOf(async () => {
      await dm.ldap.delete(dnOf('lc-alice'));
      await seen(dnOf('lc-alice'), 2);
    });
    expect(keys()).to.deep.equal(['account.deleted.notify']);
    expect(
      logs.map(l => [l.level, l.entry.routingKey, l.entry.result])
    ).to.deep.equal([
      ['error', 'account.deleted', 'error'],
      ['info', 'account.deleted.notify', 'published'],
    ]);
    expect(logs[0].entry.error).to.match(/broker down/);
  });

  it('logs an event lost for want of a broker, and does not call it published', async () => {
    rabbit.client = null;
    const logs = await logsOf(async () => {
      await add('lc-alice');
      await seen(dnOf('lc-alice'));
    });
    expect(rabbit.published).to.deep.equal([]);
    expect(logs).to.have.length(1);
    expect(logs[0].level).to.equal('error');
    expect(logs[0].entry).to.include({
      event: 'created',
      routingKey: 'account.created',
      result: 'no broker',
    });
  });

  describe('groups', () => {
    const groupDn = `cn=lcg-team,${GROUPS}`;
    const placeholder = (): string => dm.config.group_dummy_user as string;
    const messages = (): [string, unknown][] =>
      rabbit.published
        .filter(p => p.exchange === 'groups')
        .map(p => [p.routingKey, p.message]);

    async function group(members: string[] = []): Promise<void> {
      await dm.ldap.add(groupDn, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'lcg-team',
        description: 'Team',
        member: [placeholder(), ...members],
      });
      await seen(groupDn);
      rabbit.published = [];
      handled = [];
    }

    before(async () => {
      await dm.ldap
        .add(GROUPS, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'groups',
        })
        .catch(() => undefined);
    });

    afterEach(async () => {
      await dm.ldap.delete(groupDn).catch(() => undefined);
    });

    it('publishes created with its members read, the placeholder left out', async () => {
      await add('lc-alice');
      await dm.ldap.add(groupDn, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'lcg-team',
        description: 'Team',
        member: [placeholder(), dnOf('lc-alice')],
      });
      await seen(groupDn);
      expect(messages()).to.deep.equal([
        [
          'group.created',
          {
            id: 'lcg-team',
            name: 'Team',
            members: [
              {
                username: 'lc-alice',
                email: 'lc-alice@example.org',
                lastName: 'lc-alice',
                kind: 'person',
              },
            ],
          },
        ],
      ]);
    });

    it('publishes updated with the changed fields only', async () => {
      await group();
      await dm.ldap.modify(groupDn, {
        replace: { description: 'Core' },
        add: { businessCategory: '#fff' },
      });
      await seen(groupDn);
      await dm.ldap.modify(groupDn, { delete: ['businessCategory'] });
      await seen(groupDn, 2);
      expect(messages()).to.deep.equal([
        ['group.updated', { id: 'lcg-team', name: 'Core', color: '#fff' }],
        ['group.updated', { id: 'lcg-team', color: '' }],
      ]);
    });

    it('publishes no updated when only the members change', async () => {
      await add('lc-alice');
      await group();
      await dm.ldap.modify(groupDn, { add: { member: dnOf('lc-alice') } });
      await seen(groupDn);
      expect(keys()).to.deep.equal(['group.member.added']);
    });

    it('announces a replaced member list as what was added and removed', async () => {
      await add('lc-alice');
      await add('lc-bob');
      await group([dnOf('lc-alice')]);
      await dm.ldap.modify(groupDn, {
        replace: { member: [dnOf('lc-bob')] },
      });
      await seen(groupDn);
      expect(messages()).to.deep.equal([
        [
          'group.member.added',
          {
            id: 'lcg-team',
            members: [
              {
                username: 'lc-bob',
                email: 'lc-bob@example.org',
                lastName: 'lc-bob',
                kind: 'person',
              },
            ],
          },
        ],
        [
          'group.member.removed',
          {
            id: 'lcg-team',
            members: [
              {
                username: 'lc-alice',
                email: 'lc-alice@example.org',
                lastName: 'lc-alice',
                kind: 'person',
              },
            ],
          },
        ],
      ]);
    });

    it('leaves the placeholder out when the last member leaves', async () => {
      await add('lc-alice');
      await group([dnOf('lc-alice')]);
      await dm.ldap.modify(groupDn, {
        replace: { member: [placeholder()] },
      });
      await seen(groupDn);
      expect(keys()).to.deep.equal(['group.member.removed']);
      expect(
        (rabbit.published[0].message as unknown as { members: unknown[] })
          .members
      ).to.have.length(1);
    });

    it('names a member no longer in the directory by its RDN', async () => {
      await group([dnOf('lc-gone')]);
      await dm.ldap.modify(groupDn, { delete: { member: dnOf('lc-gone') } });
      await seen(groupDn);
      expect(messages()).to.deep.equal([
        [
          'group.member.removed',
          {
            id: 'lcg-team',
            members: [{ username: 'lc-gone', kind: 'person' }],
          },
        ],
      ]);
    });

    it('leaves a tombstone out of the members', async () => {
      await add('lc-alice', { employeeType: 'deleted' });
      await add('lc-bob');
      await dm.ldap.add(groupDn, {
        objectClass: ['top', 'groupOfNames'],
        cn: 'lcg-team',
        member: [dnOf('lc-alice'), dnOf('lc-bob')],
      });
      await seen(groupDn);
      const created = rabbit.published.find(
        p => p.routingKey === 'group.created'
      );
      expect(
        (
          created?.message as unknown as { members: { username: string }[] }
        ).members.map(m => m.username)
      ).to.deep.equal(['lc-bob']);
    });

    it('publishes no member.removed when only a tombstone left', async () => {
      await add('lc-alice', { employeeType: 'deleted' });
      await group([dnOf('lc-alice')]);
      await dm.ldap.modify(groupDn, { delete: { member: dnOf('lc-alice') } });
      await seen(groupDn);
      expect(keys()).to.deep.equal([]);
    });

    it('publishes deleted when the group is removed', async () => {
      await group();
      await dm.ldap.delete(groupDn);
      await seen(groupDn);
      expect(messages()).to.deep.equal([['group.deleted', { id: 'lcg-team' }]]);
    });
  });

  describe('broker', () => {
    it('refuses rules without --rabbitmq-url', () => {
      const url = dm.config.rabbitmq_url;
      dm.config.rabbitmq_url = '';
      try {
        expect(() => new TwakeLifecycleEvents(dm)).to.throw(
          /--twake-lifecycle-rules needs --rabbitmq-url/
        );
      } finally {
        dm.config.rabbitmq_url = url;
      }
    });

    it('is refused when the broker cannot be reached', async () => {
      rabbit.client = null;
      const late = new TwakeLifecycleEvents(dm);
      let refused: Error | undefined;
      await dm
        .registerPlugin('core/twake/lifecycleEvents', late, 'lifecycleLate')
        .catch((err: Error) => (refused = err));
      expect(refused?.message).to.match(/RabbitMQ at --rabbitmq-url cannot be/);
      expect(dm.loadedPlugins).not.to.have.property('lifecycleLate');
    });

    it('warns when SCIM locks accounts another way', () => {
      const warned: string[] = [];
      const { warn } = plugin.logger;
      plugin.logger.warn = ((m: string) => {
        warned.push(m);
        return plugin.logger;
      }) as typeof warn;
      const scim = dm.loadedPlugins.scim;
      try {
        for (const config of [
          { scim_user_lock_attribute: 'pwdAccountLockedTime' },
          {
            scim_user_lock_attribute: 'nsAccountLock',
            scim_user_lock_value: 'TRUE',
          },
        ]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          dm.loadedPlugins.scim = { config } as any;
          plugin.afterLoad();
        }
      } finally {
        plugin.logger.warn = warn;
        if (scim) dm.loadedPlugins.scim = scim;
        else delete dm.loadedPlugins.scim;
      }
      expect(warned).to.have.length(1);
      expect(warned[0]).to.match(/SCIM locks an account with nsAccountLock/);
    });
  });

  it('reads a GeneralizedTime deletion date', () => {
    expect(
      parseDeletedAt('20260102030405Z', 'generalizedTime')?.toISOString()
    ).to.equal('2026-01-02T03:04:05.000Z');
    expect(parseDeletedAt('yesterday', 'generalizedTime')).to.equal(undefined);
  });

  describe('lock', () => {
    const lock = (options: Partial<typeof dm.config>) => {
      const { lock, lockValue } = lifecycleAttributes({
        ...dm.config,
        twake_lifecycle_lock_attribute: '',
        twake_lifecycle_lock_value: '',
        scim_user_lock_attribute: '',
        scim_user_lock_value: '',
        ...options,
      });
      return [lock, lockValue];
    };

    it('follows the lock SCIM follows, spaces trimmed', () => {
      expect(
        lock({
          scim_user_lock_attribute: ' nsAccountLock ',
          scim_user_lock_value: ' TRUE ',
        })
      ).to.deep.equal(['nsAccountLock', 'TRUE']);
    });

    it('takes the administrative lock by default, and its own value first', () => {
      expect(lock({})).to.deep.equal(['pwdAccountLockedTime', LOCKED]);
      expect(
        lock({
          twake_lifecycle_lock_attribute: 'nsAccountLock',
          twake_lifecycle_lock_value: 'true',
          scim_user_lock_attribute: 'nsAccountLock',
          scim_user_lock_value: 'TRUE',
        })
      ).to.deep.equal(['nsAccountLock', 'true']);
    });

    it('reads a blank value of its own as none', () => {
      expect(
        lock({
          twake_lifecycle_lock_value: ' ',
          scim_user_lock_attribute: 'nsAccountLock',
          scim_user_lock_value: 'TRUE',
        })
      ).to.deep.equal(['nsAccountLock', 'TRUE']);
    });

    it('refuses an attribute without its value, even when SCIM has one for another', () => {
      expect(() =>
        lock({ twake_lifecycle_lock_attribute: 'nsAccountLock' })
      ).to.throw(/--twake-lifecycle-lock-value must say what marks/);
      expect(() =>
        lock({
          twake_lifecycle_lock_attribute: 'nsAccountLock',
          scim_user_lock_attribute: 'pwdAccountLockedTime',
          scim_user_lock_value: LOCKED,
        })
      ).to.throw(/--twake-lifecycle-lock-value must say what marks/);
    });
  });

  describe('rules', () => {
    it('reads them from a file', () => {
      const file = path.join(
        os.tmpdir(),
        `lifecycle-rules-${process.pid}.json`
      );
      fs.writeFileSync(file, JSON.stringify(RULES));
      try {
        expect(parseRules(file)).to.have.length(RULES.length);
      } finally {
        fs.unlinkSync(file);
      }
    });

    it('refuses an unknown event', () => {
      expect(() =>
        parseRules(
          JSON.stringify([{ dn: '.', exchange: 'x', events: { removed: 'k' } }])
        )
      ).to.throw(/Unknown lifecycle event "removed"/);
    });

    it('refuses a target without an exchange', () => {
      expect(() =>
        parseRules(JSON.stringify([{ dn: '.', events: { created: 'k' } }]))
      ).to.throw(/needs an exchange/);
    });

    it('refuses an object instead of an array', () => {
      expect(() =>
        parseRules(JSON.stringify({ dn: '.', exchange: 'x', events: {} }))
      ).to.throw(/must be a JSON array/);
    });

    it('refuses a null target', () => {
      expect(() =>
        parseRules(
          JSON.stringify([
            { dn: '.', exchange: 'x', events: { created: null } },
          ])
        )
      ).to.throw(/Lifecycle event "created" of \.: a target is/);
    });

    it('refuses a payload value that is not a string', () => {
      expect(() =>
        parseRules(
          JSON.stringify([
            {
              dn: '.',
              exchange: 'x',
              events: { created: { routingKey: 'k', payload: { n: 1 } } },
            },
          ])
        )
      ).to.throw(/"created" of \.: "payload" must be an object of strings/);
    });

    it('takes a member list as a payload value, and refuses any other object', () => {
      const rule = (members: unknown): string =>
        JSON.stringify([
          {
            dn: '.',
            exchange: 'x',
            events: { created: { routingKey: 'k', payload: { members } } },
          },
        ]);
      expect(() =>
        parseRules(rule({ $added: { username: '$uid' } }))
      ).not.to.throw();
      expect(() => parseRules(rule({ $all: { username: '$uid' } }))).to.throw(
        /"payload" must be an object of strings, or of \$members/
      );
      expect(() => parseRules(rule({ $added: { username: 1 } }))).to.throw(
        /"payload" must be an object of strings/
      );
      for (const source of ['$context.actor', '$dn.id', '$now'])
        expect(() =>
          parseRules(rule({ $added: { username: '$uid', other: source } }))
        ).to.throw(/member attributes \(\$attr\) or plain values/);
      expect(() =>
        parseRules(rule({ $added: { username: '$uid', kind: 'person' } }))
      ).not.to.throw();
    });

    it('refuses a condition value that is not a string', () => {
      expect(() =>
        parseRules(
          JSON.stringify([
            {
              dn: '.',
              exchange: 'x',
              events: { deleted: { routingKey: 'k', when: { $a: true } } },
            },
          ])
        )
      ).to.throw(/"deleted" of \.: "when" must be an object of strings/);
    });
  });
});
