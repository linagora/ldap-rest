import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { DM } from '../../../src/bin';
import OnLdapChange from '../../../src/plugins/ldap/onChange';
import TwakeLifecycleEvents, {
  parseRules,
} from '../../../src/plugins/twake/lifecycleEvents';
import { parseDeletedAt } from '../../../src/plugins/twake/lifecycleAttributes';

const BASE = `ou=users,${process.env.DM_LDAP_BASE}`;

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
  async publish(
    exchange: string,
    routingKey: string,
    message: Record<string, string>,
    options?: { messageId?: string }
  ): Promise<void> {
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
];

describe('Twake lifecycle events plugin', function () {
  let dm: DM;
  let rabbit: StubRabbitMq;
  let pending: Promise<unknown>[];
  let events: TwakeLifecycleEvents;

  const dnOf = (name: string): string => `uid=${name},${BASE}`;

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++)
      await new Promise(resolve => setImmediate(resolve));
    await Promise.all(pending);
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
    dm.config.twake_lifecycle_lock_attribute = 'carLicense';
    dm.config.twake_lifecycle_deleted_attribute = 'employeeType';
    dm.config.twake_lifecycle_deleted_value = 'deleted';
    dm.config.twake_lifecycle_deleted_at_attribute = 'roomNumber';
    dm.config.twake_lifecycle_rules = JSON.stringify(RULES);
    await dm.ready;
    rabbit = new StubRabbitMq();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dm.loadedPlugins['rabbitmq'] = rabbit as any;
    await dm.registerPlugin('core/ldap/onChange', new OnLdapChange(dm));
    const plugin = (events = new TwakeLifecycleEvents(dm));
    // Count the plugin's own work, so a test can wait for it to finish
    // rather than for a guessed delay.
    for (const name of ['ldapadddone', 'onLdapChange'] as const) {
      const hook = plugin.hooks[name] as (...a: unknown[]) => unknown;
      plugin.hooks[name] = async (...args: unknown[]): Promise<void> => {
        const p = Promise.resolve(hook(...args));
        pending.push(p);
        await p;
      };
    }
    await dm.registerPlugin('core/twake/lifecycleEvents', plugin);
  });

  beforeEach(() => {
    rabbit.published = [];
    rabbit.fail = false;
    pending = [];
  });

  afterEach(async () => {
    await settle();
    rabbit.fail = false;
    for (const name of ['lc-alice', 'lc-bob', 'other-carol']) {
      await dm.ldap.delete(dnOf(name)).catch(() => undefined);
    }
    await settle();
  });

  it('publishes created with the configured payload', async () => {
    await add('lc-alice', { title: 'member' });
    await settle();
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
      await settle();
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
    await settle();
    expect(rabbit.published).to.deep.equal([]);
  });

  it('publishes roleChanged with the previous role', async () => {
    await add('lc-alice', { title: 'member' });
    await settle();
    rabbit.published = [];
    await dm.ldap.modify(dnOf('lc-alice'), { replace: { title: 'admin' } });
    await dm.ldap.modify(dnOf('lc-alice'), { replace: { title: 'admin' } });
    await settle();
    expect(rabbit.published.map(p => [p.routingKey, p.message])).to.deep.equal([
      [
        'account.role.changed',
        { id: 'lc-alice', role: 'admin', previousRole: 'member' },
      ],
    ]);
  });

  it('publishes disabled and enabled when the lock is set and cleared', async () => {
    await add('lc-alice');
    await dm.ldap.modify(dnOf('lc-alice'), { replace: { carLicense: 'L' } });
    await settle();
    await dm.ldap.modify(dnOf('lc-alice'), { delete: ['carLicense'] });
    await settle();
    expect(keys()).to.deep.equal([
      'account.created',
      'account.disabled',
      'account.enabled',
    ]);
  });

  it('publishes enabled when an operational lock the snapshot missed is cleared', async () => {
    await add('lc-alice');
    await settle();
    rabbit.published = [];
    // What core/ldap/onChange reports for a lock `*` does not return, such
    // as pwdAccountLockedTime: no old value, and the delete accepted.
    await events.hooks.onLdapChange!(dnOf('lc-alice'), {
      carLicense: [undefined as unknown as null, null],
    });
    expect(keys()).to.deep.equal(['account.enabled']);
  });

  describe('deletion', () => {
    const deletedAt = '2026-01-02T03:04:05.000Z';

    async function tombstone(reason = 'member_deleted'): Promise<void> {
      await dm.ldap.modify(dnOf('lc-alice'), {
        replace: {
          employeeType: 'deleted',
          roomNumber: deletedAt,
          businessCategory: reason,
          carLicense: 'L',
        },
        delete: ['mobile'],
      });
    }

    beforeEach(async () => {
      await add('lc-alice', { mobile: '+33600000000' });
      await settle();
      rabbit.published = [];
    });

    it('publishes deleted, and not disabled, when the entry becomes a tombstone', async () => {
      await tombstone();
      await settle();
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

    it('publishes a target only when its condition holds', async () => {
      await tombstone('user_request');
      await settle();
      expect(
        rabbit.published.map(p => [p.exchange, p.routingKey, p.message])
      ).to.deep.include([
        'notifications',
        'account.deleted.notify',
        { id: 'lc-alice', mobile: '+33600000000' },
      ]);
    });

    it('publishes deleted again when the flag is written on a tombstone', async () => {
      await tombstone();
      await settle();
      await dm.ldap.modify(dnOf('lc-alice'), {
        replace: { employeeType: 'deleted' },
      });
      await settle();
      expect(keys()).to.deep.equal(['account.deleted', 'account.deleted']);
      expect(rabbit.published[1].message.deletedAt).to.equal(deletedAt);
    });

    it('publishes nothing for other changes to a tombstone', async () => {
      await tombstone();
      await settle();
      rabbit.published = [];
      await dm.ldap.modify(dnOf('lc-alice'), {
        delete: ['carLicense'],
        replace: { title: 'admin' },
      });
      await settle();
      expect(rabbit.published).to.deep.equal([]);
    });

    it('publishes nothing when a tombstone is removed', async () => {
      await tombstone();
      await settle();
      rabbit.published = [];
      await dm.ldap.delete(dnOf('lc-alice'));
      await settle();
      expect(rabbit.published).to.deep.equal([]);
    });

    it('publishes deleted when a live entry is removed', async () => {
      await dm.ldap.delete(dnOf('lc-alice'));
      await settle();
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
    await settle();
    const res = await dm.ldap.search(
      { scope: 'base', paged: false },
      dnOf('lc-alice')
    );
    expect(res).to.have.nested.property('searchEntries.length', 1);
  });

  it('reads a GeneralizedTime deletion date', () => {
    expect(
      parseDeletedAt('20260102030405Z', 'generalizedTime')?.toISOString()
    ).to.equal('2026-01-02T03:04:05.000Z');
    expect(parseDeletedAt('yesterday', 'generalizedTime')).to.equal(undefined);
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
  });
});
