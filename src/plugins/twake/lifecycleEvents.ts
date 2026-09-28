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

import type { Entry } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type { ChangeContext } from '../../lib/changeContext';
import type { AttributesList } from '../../lib/ldapActions';
import { diffEntries } from '../ldap/onChange';
import type RabbitMq from '../rabbitmq';

import {
  first,
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
  after: AttributesList;
  before: AttributesList;
  dn: Record<string, string>;
  change: ChangeContext;
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
    // An operational lock such as pwdAccountLockedTime is in neither side of
    // onLdapEntryChange unless asked for by name.
    this.followedOperationalAttributes = [this.attrs.lock];
    this.rules = parseRules(this.config.twake_lifecycle_rules || '');
    if (this.rules.length === 0)
      this.logger.warn(
        `${this.name}: --twake-lifecycle-rules is empty, nothing will be published`
      );
  }

  hooks: Hooks = {
    onLdapEntryChange: (dn, before, after, context) =>
      this.onEntryChange(
        dn,
        before as AttributesList | null,
        after as AttributesList | null,
        context
      ),
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

  private async onEntryChange(
    dn: string,
    before: AttributesList | null,
    after: AttributesList | null,
    change: ChangeContext
  ): Promise<void> {
    const found = this.match(dn);
    // Past the write that made it, a tombstone announces nothing: not its
    // later changes, not its removal.
    if (!found || (before && isTombstone(before, this.attrs))) return;
    const { rule } = found;
    const ctx: EventContext = {
      before: before || {},
      after: after || before || {},
      dn: found.groups,
      change,
    };
    if (!after) return this.publish(rule, 'deleted', ctx);
    if (isTombstone(after, this.attrs))
      return before ? this.publish(rule, 'deleted', ctx) : undefined;
    if (!before) return this.publish(rule, 'created', ctx);

    const changes = diffEntries(before as Entry, after as Entry);
    if (valueOf(changes, this.attrs.role))
      await this.publish(rule, 'roleChanged', ctx);
    const lock = valueOf(changes, this.attrs.lock);
    if (lock?.[0] === null) await this.publish(rule, 'disabled', ctx);
    else if (lock?.[1] === null) await this.publish(rule, 'enabled', ctx);
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
    } else if (expr.startsWith('context.')) {
      value = ctx.change[expr.slice(8) as keyof ChangeContext];
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
      // Without a client, rabbitmq.publish returns without error or sending.
      if (!(await rabbitmq.getRawClient())) {
        this.logger.error({ ...log, result: 'no broker' });
        continue;
      }
      try {
        await rabbitmq.publish(target.exchange, target.routingKey, message, {
          messageId,
        });
        this.logger.info({ ...log, result: 'published' });
      } catch (err) {
        this.logger.error({ ...log, result: 'error', error: String(err) });
      }
    }
  }
}
