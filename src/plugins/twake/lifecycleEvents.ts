/**
 * @module plugins/twake/lifecycleEvents
 *
 * Publishes an account's lifecycle to RabbitMQ from the directory write
 * itself, so every API that writes the entry announces the same thing:
 * created, role changed, disabled, enabled, deleted.
 *
 * Which entries are accounts, which attributes carry the role, the lock and
 * the deletion, and where each event goes are configuration: see
 * `docs/usage/plugins/integrations/lifecycle-events.md`.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import type { ChangesToNotify } from '../ldap/onChange';
import type RabbitMq from '../rabbitmq';

import {
  first,
  holdsDeleted,
  isTombstone,
  lifecycleAttributes,
  parseDeletedAt,
  valueOf,
  type LifecycleAttributes,
} from './lifecycleAttributes';

export const LIFECYCLE_EVENTS = [
  'created',
  'roleChanged',
  'disabled',
  'enabled',
  'deleted',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

type Payload = Record<string, string>;

interface RawTarget {
  routingKey: string;
  exchange?: string;
  payload?: Payload;
  when?: Payload;
}

interface RawRule {
  dn: string;
  exchange?: string;
  payload?: Payload;
  events?: Partial<
    Record<LifecycleEvent, string | RawTarget | (string | RawTarget)[]>
  >;
}

interface Target {
  exchange: string;
  routingKey: string;
  payload: Payload;
  when: Payload;
}

interface Rule {
  dn: RegExp;
  targets: Partial<Record<LifecycleEvent, Target[]>>;
}

interface EventContext {
  after: Record<string, AttributeValue | null>;
  before: Record<string, AttributeValue | null>;
  dn: Record<string, string>;
}

export function parseRules(source: string): Rule[] {
  if (!source.trim()) return [];
  const text = /^\s*\[/.test(source) ? source : fs.readFileSync(source, 'utf8');
  const raw = JSON.parse(text) as RawRule[];
  if (!Array.isArray(raw))
    throw new Error('--twake-lifecycle-rules must be a JSON array of rules');
  return raw.map(rule => {
    if (typeof rule.dn !== 'string')
      throw new Error('Every lifecycle rule needs a "dn" pattern');
    const targets: Rule['targets'] = {};
    for (const [event, value] of Object.entries(rule.events || {})) {
      if (!(LIFECYCLE_EVENTS as readonly string[]).includes(event))
        throw new Error(
          `Unknown lifecycle event "${event}"; known: ${LIFECYCLE_EVENTS.join(', ')}`
        );
      targets[event as LifecycleEvent] = (
        Array.isArray(value) ? value : [value]
      ).map(one => {
        const t: RawTarget =
          typeof one === 'string' ? { routingKey: one } : one;
        const exchange = t.exchange || rule.exchange;
        if (!exchange || !t.routingKey)
          throw new Error(
            `Lifecycle event "${event}" of ${rule.dn} needs an exchange and a routing key`
          );
        return {
          exchange,
          routingKey: t.routingKey,
          payload: t.payload || rule.payload || {},
          when: t.when || {},
        };
      });
    }
    return { dn: new RegExp(rule.dn, 'i'), targets };
  });
}

export default class TwakeLifecycleEvents extends DmPlugin {
  name = 'twakeLifecycleEvents';
  roles: Role[] = ['consistency'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
    rabbitmq: 'core/rabbitmq',
  };

  private readonly rules: Rule[];
  private readonly attrs: LifecycleAttributes;

  constructor(server: DM) {
    super(server);
    this.attrs = lifecycleAttributes(this.config);
    this.rules = parseRules(this.config.twake_lifecycle_rules || '');
    if (this.rules.length === 0)
      this.logger.warn(
        `${this.name}: --twake-lifecycle-rules is empty, nothing will be published`
      );
  }

  hooks: Hooks = {
    ldapadddone: ([dn, entry]) => this.onAdd(dn, entry),
    onLdapChange: (dn, changes) => this.onChange(dn, changes),
  };

  private match(
    dn: string
  ): { rule: Rule; groups: Record<string, string> } | undefined {
    for (const rule of this.rules) {
      const m = rule.dn.exec(dn);
      if (m) return { rule, groups: { ...m.groups } };
    }
    return undefined;
  }

  private async onAdd(dn: string, entry: AttributesList): Promise<void> {
    const found = this.match(dn);
    if (!found || isTombstone(entry, this.attrs)) return;
    await this.publish(found.rule, 'created', {
      after: entry,
      before: {},
      dn: found.groups,
    });
  }

  private async onChange(dn: string, changes: ChangesToNotify): Promise<void> {
    const found = this.match(dn);
    if (!found) return;
    const objectClass = valueOf(changes, 'objectClass');
    // An add is announced by ldapadddone, which sees the whole entry.
    if (objectClass && !objectClass[0]) return;

    const before: EventContext['before'] = {};
    const updated: EventContext['after'] = {};
    for (const [attr, [old, now]] of Object.entries(changes)) {
      before[attr] = old;
      updated[attr] = now;
    }

    // Only a delete takes the object classes away.
    if (objectClass && !objectClass[1]) {
      // Erasing a tombstone is not a deletion: that one was announced when
      // the tombstone was written.
      if (isTombstone(before as AttributesList, this.attrs)) return;
      await this.publish(found.rule, 'deleted', {
        after: before,
        before,
        dn: found.groups,
      });
      return;
    }

    const current = await this.read(dn);
    if (!current) return;
    const ctx: EventContext = {
      after: current,
      before: { ...current, ...before },
      dn: found.groups,
    };

    const deleted = valueOf(changes, this.attrs.deleted);
    // Writing the flag again on a tombstone announces it again, so a
    // deletion whose event was lost can be replayed by deleting once more.
    if (deleted && holdsDeleted(deleted[1], this.attrs)) {
      await this.publish(found.rule, 'deleted', ctx);
      return;
    }
    if (isTombstone(current, this.attrs)) return;

    const role = valueOf(changes, this.attrs.role);
    if (role && first(role[0]) !== first(role[1]))
      await this.publish(found.rule, 'roleChanged', ctx);

    const lock = valueOf(changes, this.attrs.lock);
    if (lock) {
      // The snapshot core/ldap/onChange takes before a modify reads `*`, which
      // leaves out an operational lock such as pwdAccountLockedTime. A delete
      // the directory accepted means the lock was there.
      const was = first(lock[0]) !== undefined || lock[1] === null;
      const is = first(lock[1]) !== undefined;
      if (!was && is) await this.publish(found.rule, 'disabled', ctx);
      if (was && !is) await this.publish(found.rule, 'enabled', ctx);
    }
  }

  private async read(dn: string): Promise<AttributesList | undefined> {
    try {
      const res = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['*', this.attrs.lock] },
        dn
      )) as SearchResult;
      return res.searchEntries[0] as AttributesList | undefined;
    } catch (err) {
      this.logger.warn({
        plugin: this.name,
        event: 'read',
        dn,
        error: String(err),
      });
      return undefined;
    }
  }

  private resolve(source: string, ctx: EventContext): string | undefined {
    if (!source.startsWith('$')) return source;
    if (source === '$now') return new Date().toISOString();
    let expr = source.slice(1);
    const domain = expr.endsWith('|domain');
    if (domain) expr = expr.slice(0, -'|domain'.length);
    let value: string | undefined;
    let attr = expr;
    if (expr.startsWith('dn.')) {
      value = ctx.dn[expr.slice(3)];
      attr = '';
    } else if (expr.startsWith('previous.')) {
      attr = expr.slice('previous.'.length);
      value = first(valueOf(ctx.before, attr));
    } else {
      value = first(valueOf(ctx.after, attr));
    }
    if (
      value !== undefined &&
      this.attrs.deletedAt &&
      attr.toLowerCase() === this.attrs.deletedAt.toLowerCase()
    )
      value = parseDeletedAt(value, this.attrs.deletedAtFormat)?.toISOString();
    if (domain) value = value?.split('@')[1];
    return value;
  }

  private async publish(
    rule: Rule,
    event: LifecycleEvent,
    ctx: EventContext
  ): Promise<void> {
    const targets = rule.targets[event];
    if (!targets?.length) return;
    const rabbitmq = this.requirePlugin<RabbitMq>('rabbitmq');
    if (!rabbitmq) return;
    for (const target of targets) {
      const applies = Object.entries(target.when).every(([source, wanted]) => {
        const value = this.resolve(source, ctx);
        return wanted.startsWith('!')
          ? value !== wanted.slice(1)
          : value === wanted;
      });
      if (!applies) continue;
      const message: Record<string, string> = {};
      for (const [field, source] of Object.entries(target.payload)) {
        const value = this.resolve(source, ctx);
        if (value !== undefined) message[field] = value;
      }
      const messageId = randomUUID();
      const log = {
        plugin: this.name,
        event,
        exchange: target.exchange,
        routingKey: target.routingKey,
        messageId,
      };
      try {
        await rabbitmq.publish(target.exchange, target.routingKey, message, {
          messageId,
        });
        this.logger.info({ ...log, result: 'published' });
      } catch (err) {
        // The write is done; a lost event is replayed by writing again.
        this.logger.error({ ...log, result: 'error', error: String(err) });
      }
    }
  }
}
