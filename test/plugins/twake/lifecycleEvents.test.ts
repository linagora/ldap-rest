import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import type { Request } from 'express';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import TwakeLifecycleEvents, {
  parseRules,
} from '../../../src/plugins/twake/lifecycleEvents';
import {
  lifecycleAttributes,
  parseDeletedAt,
} from '../../../src/plugins/twake/lifecycleAttributes';
import { waitFor } from '../../helpers/waitFor';

const BASE = `ou=users,${process.env.DM_LDAP_BASE}`;
const LOCKED = '000001010000Z';

interface Published {
  exchange: string;
  routingKey: string;
  message: Record<string, string>;
  messageId?: string;
}

class StubRabbitMq {
  name = 'rabbitmq';
  published: Published[] = [];
  fail = false;
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
    if (this.fail) throw new Error('broker down');
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
    await dm.ready;
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const plugin = new TwakeLifecycleEvents(dm);
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
    rabbit.fail = false;
    rabbit.client = {};
    handled = [];
  });

  afterEach(async () => {
    rabbit.fail = false;
    rabbit.client = {};
    for (const name of [
      'lc-alice',
      'lc-bob',
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

  it('logs a failed publish and lets the write succeed', async () => {
    rabbit.fail = true;
    await add('lc-alice');
    await seen(dnOf('lc-alice'));
    const res = await dm.ldap.search(
      { scope: 'base', paged: false },
      dnOf('lc-alice')
    );
    expect(res).to.have.nested.property('searchEntries.length', 1);
  });

  it('logs an event lost for want of a broker, and does not call it published', async () => {
    rabbit.client = null;
    const logged: { level: string; entry: Record<string, unknown> }[] = [];
    const logger = dm.logger;
    const { error, info } = logger;
    logger.error = ((entry: Record<string, unknown>) => {
      logged.push({ level: 'error', entry });
      return logger;
    }) as typeof logger.error;
    logger.info = ((entry: Record<string, unknown>) => {
      logged.push({ level: 'info', entry });
      return logger;
    }) as typeof logger.info;
    try {
      await add('lc-alice');
      await seen(dnOf('lc-alice'));
    } finally {
      logger.error = error;
      logger.info = info;
    }
    expect(rabbit.published).to.deep.equal([]);
    const mine = logged.filter(
      l => (l.entry as { plugin?: string })?.plugin === 'twakeLifecycleEvents'
    );
    expect(mine).to.have.length(1);
    expect(mine[0].level).to.equal('error');
    expect(mine[0].entry).to.include({
      event: 'created',
      routingKey: 'account.created',
      result: 'no broker',
    });
  });

  it('reads a GeneralizedTime deletion date', () => {
    expect(
      parseDeletedAt('20260102030405Z', 'generalizedTime')?.toISOString()
    ).to.equal('2026-01-02T03:04:05.000Z');
    expect(parseDeletedAt('yesterday', 'generalizedTime')).to.equal(undefined);
  });

  it('follows the lock attribute SCIM follows, spaces trimmed', () => {
    expect(
      lifecycleAttributes({
        ...dm.config,
        twake_lifecycle_lock_attribute: '',
        scim_user_lock_attribute: ' nsAccountLock ',
      }).lock
    ).to.equal('nsAccountLock');
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
