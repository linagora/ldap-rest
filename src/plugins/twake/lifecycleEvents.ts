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
import type { ChangeContext } from '../../lib/changeContext';
import type { AttributesList, AttributeValue } from '../../lib/ldapActions';
import { parseDn, unescapeDnValue } from '../../lib/utils';
import type RabbitMq from '../rabbitmq';

import {
  first,
  isLocked,
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

/**
 * Role attributes such as `title` match case-insensitively: a change of case
 * alone is no change of role.
 */
function sameIgnoringCase(
  a: AttributeValue | undefined,
  b: AttributeValue | undefined
): boolean {
  const set = (value: AttributeValue | undefined): Set<string> =>
    new Set(
      (value === undefined ? [] : Array.isArray(value) ? value : [value]).map(
        v => v.toString().toLowerCase()
      )
    );
  const x = set(a);
  const y = set(b);
  return x.size === y.size && [...x].every(v => y.has(v));
}

/**
 * The DN as rules see it: no spaces around separators, and escaped commas in
 * hex so that a group such as `(?<id>[^,]+)` takes the whole value.
 */
function dnForRules(dn: string): string {
  return parseDn(dn)
    .map(rdn => {
      const eq = rdn.indexOf('=');
      if (eq === -1) return rdn;
      const value = rdn.slice(eq + 1).trim();
      return `${rdn.slice(0, eq).trim()}=${value.replace(/\\,/g, '\\2C')}`;
    })
    .join(',');
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalString(value: unknown, where: string, key: string): void {
  if (value !== undefined && typeof value !== 'string')
    throw new Error(`${where}: "${key}" must be a string`);
}

function optionalPayload(
  value: unknown,
  where: string,
  key: string
): Payload | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some(v => typeof v !== 'string'))
    throw new Error(`${where}: "${key}" must be an object of strings`);
  return value as Payload;
}

export function parseRules(source: string): Rule[] {
  if (!source.trim()) return [];
  const text = /^\s*[[{]/.test(source)
    ? source
    : fs.readFileSync(source, 'utf8');
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw))
    throw new Error('--twake-lifecycle-rules must be a JSON array of rules');
  return raw.map((rule: unknown) => {
    if (!isObject(rule))
      throw new Error('Every lifecycle rule must be an object');
    if (typeof rule.dn !== 'string')
      throw new Error('Every lifecycle rule needs a "dn" pattern');
    const { dn } = rule;
    const ruleWhere = `Lifecycle rule ${dn}`;
    optionalString(rule.exchange, ruleWhere, 'exchange');
    const rulePayload = optionalPayload(rule.payload, ruleWhere, 'payload');
    if (rule.events !== undefined && !isObject(rule.events))
      throw new Error(`${ruleWhere}: "events" must be an object`);
    const targets: Rule['targets'] = {};
    for (const [event, value] of Object.entries(rule.events || {})) {
      if (!(LIFECYCLE_EVENTS as readonly string[]).includes(event))
        throw new Error(
          `Unknown lifecycle event "${event}"; known: ${LIFECYCLE_EVENTS.join(', ')}`
        );
      const where = `Lifecycle event "${event}" of ${dn}`;
      targets[event as LifecycleEvent] = (
        Array.isArray(value) ? value : [value]
      ).map((one: unknown) => {
        if (typeof one !== 'string' && !isObject(one))
          throw new Error(`${where}: a target is a routing key or an object`);
        const t: Json = typeof one === 'string' ? { routingKey: one } : one;
        optionalString(t.routingKey, where, 'routingKey');
        optionalString(t.exchange, where, 'exchange');
        const exchange = (t.exchange || rule.exchange) as string | undefined;
        const routingKey = t.routingKey as string | undefined;
        if (!exchange || !routingKey)
          throw new Error(`${where} needs an exchange and a routing key`);
        return {
          exchange,
          routingKey,
          payload:
            optionalPayload(t.payload, where, 'payload') || rulePayload || {},
          when: optionalPayload(t.when, where, 'when') || {},
        };
      });
    }
    return { dn: new RegExp(dn, 'i'), targets };
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
    else if (!this.config.rabbitmq_url)
      throw new Error(
        `${this.name}: --twake-lifecycle-rules needs --rabbitmq-url`
      );
  }

  /**
   * No route: this is the one step of loading that is awaited, so the server
   * can still refuse to start. core/rabbitmq connects lazily and hands back
   * no client when it cannot, and every event would then be lost.
   */
  async api(): Promise<void> {
    if (this.rules.length === 0) return;
    if (!(await this.requirePlugin<RabbitMq>('rabbitmq')?.getRawClient()))
      throw new Error(
        `${this.name}: RabbitMQ at --rabbitmq-url cannot be reached`
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
    const spelled = dnForRules(dn);
    for (const rule of this.rules) {
      const m = rule.dn.exec(spelled);
      if (!m) continue;
      const groups: Record<string, string> = {};
      for (const [name, value] of Object.entries(m.groups || {}))
        if (value !== undefined) groups[name] = unescapeDnValue(value);
      return { rule, groups };
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
    if (!before) {
      await this.publish(rule, 'created', ctx);
      if (isLocked(after, this.attrs))
        await this.publish(rule, 'disabled', ctx);
      return;
    }

    if (
      this.attrs.role &&
      !sameIgnoringCase(
        valueOf(before, this.attrs.role),
        valueOf(after, this.attrs.role)
      )
    )
      await this.publish(rule, 'roleChanged', ctx);
    const locked = isLocked(after, this.attrs);
    if (locked !== isLocked(before, this.attrs))
      await this.publish(rule, locked ? 'disabled' : 'enabled', ctx);
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
