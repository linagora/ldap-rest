/**
 * @module plugins/twake/lifecycleEvents
 *
 * Publishes an account's or a group's lifecycle to RabbitMQ from the
 * directory write itself, so every API that writes the entry announces the
 * same thing: created, role changed, disabled, enabled, updated, members
 * added or removed, deleted.
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
import { extractLdapCode } from '../../lib/ldapCodes';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import {
  isDummyMemberDn,
  normalizeDn,
  parseDn,
  unescapeDnValue,
} from '../../lib/utils';
import type RabbitMq from '../rabbitmq';
import { DEFAULT_LOCK_ATTRIBUTE, DEFAULT_LOCK_VALUE } from '../scim/mapping';

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
  'updated',
  'memberAdded',
  'memberRemoved',
  'deleted',
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const MEMBER_LISTS = ['$members', '$added', '$removed'] as const;

/** A payload field listing members, each read and shaped by `fields`. */
interface MemberList {
  list: (typeof MEMBER_LISTS)[number];
  fields: Record<string, string>;
}

type Payload = Record<string, string | MemberList>;
type Condition = Record<string, string>;

interface Target {
  exchange: string;
  routingKey: string;
  payload: Payload;
  when: Condition;
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
  added?: string[];
  removed?: string[];
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

const isStrings = (value: unknown): value is Condition =>
  isObject(value) && Object.values(value).every(v => typeof v === 'string');

function optionalCondition(
  value: unknown,
  where: string,
  key: string
): Condition | undefined {
  if (value === undefined) return undefined;
  if (!isStrings(value))
    throw new Error(`${where}: "${key}" must be an object of strings`);
  return value;
}

/**
 * A member's sources are its own attributes or plain values: `$dn.`,
 * `$context.` or `$now` would be read as attribute names and dropped.
 */
const MEMBER_SOURCE = /^(?:[^$].*|\$(?!now$)[A-Za-z][A-Za-z0-9-]*)$/;

function memberList(value: unknown): MemberList | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length !== 1) return undefined;
  const [list, fields] = entries[0];
  if (
    !(MEMBER_LISTS as readonly string[]).includes(list) ||
    !isStrings(fields) ||
    !Object.values(fields).every(s => MEMBER_SOURCE.test(s))
  )
    return undefined;
  return { list: list as MemberList['list'], fields };
}

function optionalPayload(
  value: unknown,
  where: string,
  key: string
): Payload | undefined {
  if (value === undefined) return undefined;
  const fields = isObject(value) ? Object.entries(value) : undefined;
  const payload: Payload = {};
  for (const [field, source] of fields || []) {
    const parsed = typeof source === 'string' ? source : memberList(source);
    if (parsed === undefined) break;
    payload[field] = parsed;
  }
  if (!fields || Object.keys(payload).length !== fields.length)
    throw new Error(
      `${where}: "${key}" must be an object of strings, or of ` +
        `${MEMBER_LISTS.join(', ')} each mapped to an object of member ` +
        'attributes ($attr) or plain values'
    );
  return payload;
}

/** Two values of an attribute are the same set, whatever their order. */
function sameValues(
  a: AttributeValue | undefined,
  b: AttributeValue | undefined
): boolean {
  const list = (value: AttributeValue | undefined): string[] =>
    (value === undefined ? [] : Array.isArray(value) ? value : [value])
      .map(v => v.toString())
      .sort();
  return list(a).join('\0') === list(b).join('\0');
}

/** A DN as compared between two member lists. */
function dnKey(dn: string): string {
  try {
    return normalizeDn(dn);
  } catch {
    return dn.toLowerCase();
  }
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
          when: optionalCondition(t.when, where, 'when') || {},
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
  private readonly memberAttribute: string;

  constructor(server: DM) {
    super(server);
    this.attrs = lifecycleAttributes(this.config);
    this.memberAttribute =
      this.config.twake_lifecycle_member_attribute || 'member';
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
   * core/rabbitmq connects lazily and hands back no client when it cannot:
   * every event would then be lost, so the server does not start.
   */
  async assertComposition(): Promise<void> {
    if (this.rules.length === 0) return;
    if (!(await this.requirePlugin<RabbitMq>('rabbitmq')?.getRawClient()))
      throw new Error(
        `${this.name}: RabbitMQ at --rabbitmq-url cannot be reached`
      );
  }

  /**
   * SCIM deactivates by writing its own lock: on another attribute or
   * value, `disabled` and `enabled` never follow a SCIM `active` change.
   */
  afterLoad(): void {
    const scim = this.server.loadedPlugins.scim?.config;
    if (!scim) return;
    const attribute =
      scim.scim_user_lock_attribute?.trim() || DEFAULT_LOCK_ATTRIBUTE;
    // SCIM refused to start on a non-default attribute without its value
    const value = scim.scim_user_lock_value?.trim() || DEFAULT_LOCK_VALUE;
    const { lock, lockValue } = this.attrs;
    if (
      attribute.toLowerCase() !== lock.toLowerCase() ||
      value.toLowerCase() !== lockValue.toLowerCase()
    )
      this.logger.warn(
        `${this.name}: SCIM locks an account with ${attribute}: ${value}, ` +
          `these events read ${lock}: ${lockValue}, so a SCIM deactivation ` +
          'publishes no disabled'
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
    // core/twake/tombstone, on a second delete of a tombstone: nothing is
    // written, so this is the one way the deletion is announced again.
    twakedeletionreplay: (
      dn: string,
      entry: AttributesList,
      context: ChangeContext
    ) => this.replay(dn, entry, context),
  };

  private async replay(
    dn: string,
    entry: AttributesList,
    change: ChangeContext
  ): Promise<void> {
    const found = this.match(dn);
    if (!found || !isTombstone(entry, this.attrs)) return;
    await this.publish(found.rule, 'deleted', {
      before: entry,
      after: entry,
      dn: found.groups,
      change,
    });
  }

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
    await this.publish(rule, 'updated', ctx);
    // A set difference, so a whole list replaced announces only what moved.
    const added = this.memberDiff(after, before);
    const removed = this.memberDiff(before, after);
    if (added.length)
      await this.publish(rule, 'memberAdded', { ...ctx, added });
    if (removed.length)
      await this.publish(rule, 'memberRemoved', { ...ctx, removed });
  }

  /** The members of an entry, the group placeholder left out. */
  private members(entry: AttributesList): string[] {
    const value = valueOf(entry, this.memberAttribute);
    const list =
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    return list
      .map(v => v.toString())
      .filter(m => !isDummyMemberDn(m, this.config.group_dummy_user));
  }

  private memberDiff(from: AttributesList, other: AttributesList): string[] {
    const held = new Set(this.members(other).map(dnKey));
    return this.members(from).filter(m => !held.has(dnKey(m)));
  }

  /**
   * A member list of a payload: one read per member, a tombstone left out,
   * and a member no longer in the directory given its RDN alone.
   */
  private async memberPayloads(
    { list, fields }: MemberList,
    ctx: EventContext
  ): Promise<Record<string, string>[]> {
    const dns =
      list === '$added'
        ? ctx.added || []
        : list === '$removed'
          ? ctx.removed || []
          : this.members(ctx.after);
    const attributes = Object.values(fields)
      .filter(s => s.startsWith('$'))
      .map(s => s.slice(1));
    if (this.attrs.deleted) attributes.push(this.attrs.deleted);
    const out: Record<string, string>[] = [];
    for (const dn of dns) {
      const entry = await this.readMember(dn, attributes);
      if (!entry || isTombstone(entry, this.attrs)) continue;
      const one: Record<string, string> = {};
      for (const [field, source] of Object.entries(fields)) {
        const value = source.startsWith('$')
          ? first(valueOf(entry, source.slice(1)))
          : source;
        if (value !== undefined) one[field] = value;
      }
      out.push(one);
    }
    return out;
  }

  private async readMember(
    dn: string,
    attributes: string[]
  ): Promise<AttributesList | undefined> {
    try {
      const { searchEntries } = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes },
        dn
      )) as SearchResult;
      if (searchEntries[0]) return searchEntries[0];
    } catch (err) {
      if (extractLdapCode(err) !== 32) throw err;
    }
    const [rdn] = parseDn(dn);
    const eq = rdn?.indexOf('=') ?? -1;
    if (eq === -1) return undefined;
    return {
      [rdn.slice(0, eq).trim()]: unescapeDnValue(rdn.slice(eq + 1).trim()),
    };
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
    } else if (expr.startsWith('changed.')) {
      attr = expr.slice('changed.'.length);
      const now = valueOf(ctx.after, attr);
      // A removed value is a change too: it reads as empty.
      if (!sameValues(valueOf(ctx.before, attr), now)) value = first(now) ?? '';
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
      const message: Record<string, unknown> = {};
      // A payload made of `$changed.` fields says what changed: with none of
      // them changed, there is nothing to say.
      let watches = false;
      let changed = false;
      // Only tombstones came or went: nobody to announce.
      let empty = false;
      try {
        for (const [field, source] of Object.entries(target.payload)) {
          if (typeof source !== 'string') {
            const members = await this.memberPayloads(source, ctx);
            if (!members.length && source.list !== '$members') empty = true;
            message[field] = members;
            continue;
          }
          const value = this.resolve(source, ctx);
          if (source.startsWith('$changed.')) {
            watches = true;
            if (value !== undefined) changed = true;
          }
          if (value !== undefined) message[field] = value;
        }
      } catch (err) {
        this.logger.error({
          plugin: this.name,
          event,
          routingKey: target.routingKey,
          result: 'members unreadable',
          error: String(err),
        });
        continue;
      }
      if (empty || (watches && !changed)) continue;
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
