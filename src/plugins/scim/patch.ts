/**
 * @module plugins/scim/patch
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM PatchOp applicator (RFC 7644 §3.5.2) → ldapts ModifyRequest.
 *
 * Supports:
 *  - op: add / remove / replace
 *  - simple paths:  "displayName", "userName"
 *  - sub-attribute paths: "name.familyName"
 *  - multi-valued paths: "emails"
 *  - Group member ops via filtered path: `members[value eq "alice"]`
 *  - implicit path (op.value is an object) for add and replace; `remove`
 *    without a path is rejected with `noTarget` per RFC 7644 section 3.5.2.2
 *
 * Complex filtered paths on multi-valued attributes OTHER than `members`
 * (e.g. `emails[type eq "work"]`) are rejected with `invalidPath`: the
 * plugin only knows how to map them for member-type resolution. Filtered
 * member operations for Groups are handled via the caller-provided
 * `resolveMemberRef` hook (SCIM id → LDAP DN lookup).
 */
import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
} from '../../lib/ldapActions';

import { scimInvalidPath, scimNoTarget, scimInvalidValue } from './errors';
import {
  type ResourceMapping,
  type PatchOperation,
  type PatchRequest,
} from './types';
import {
  DEFAULT_LOCK_ATTRIBUTE,
  DEFAULT_LOCK_VALUE,
  readActive,
  scimPathToLdapAttribute,
} from './mapping';

export interface PatchContext {
  mapping: ResourceMapping;
  /** For Groups: resolve SCIM member value (id or $ref) → LDAP DN. Async. */
  resolveMemberRef?: (value: string) => Promise<string | undefined>;
  /** The LDAP attribute holding members, default 'member'. */
  memberAttribute?: string;
  /**
   * For Users: the attribute whose presence marks the account as locked, and
   * the value to write when SCIM `active` is set to false.
   */
  lockAttribute?: string;
  lockValue?: string;
  /** True when this resource type carries SCIM `active` (Users only). */
  supportsActive?: boolean;
  /**
   * The entry as it stands. RFC 7644 section 3.5.2 applies operations in
   * order, so they are played against this and only the resulting difference
   * is sent — without it, two operations touching one attribute would
   * collapse into whichever the emitter happened to keep.
   */
  current: AttributesList;
}

/**
 * Attribute values as a plain list, whatever ldapts handed back.
 *
 * The empty string is not a value. ldapts signals an attribute that was
 * requested and is absent with an empty array, and a directory refuses to
 * store an empty value for the usual syntaxes — OpenLDAP answers
 * `invalid per syntax` (0x15) — so anything empty reaching here means
 * "not there", whether it arrives as `''`, `[]` or `['']`.
 *
 * Both shapes have to agree on that. They did not: a scalar `''` read as
 * absent while an array `['']` kept the empty string, so the same attribute
 * diffed differently depending on how it was rendered.
 *
 * Erring toward "absent" is the deliberate direction. A removal of something
 * that was not there emits nothing; the opposite reading would emit a delete
 * that answers noSuchAttribute and fails the whole atomic modify, taking the
 * operations sent alongside it down — which is the very failure this module
 * exists to avoid.
 */
function asValues(v: AttributeValue | undefined): string[] {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list
    .map(x => (Buffer.isBuffer(x) ? x.toString() : String(x)))
    .filter(s => s.length > 0);
}

/**
 * The entry being patched, as the operations see it.
 *
 * Operations mutate this in order; `diff()` then says what the directory
 * must be told. Two consequences fall out. A later operation on an attribute
 * wins over an earlier one, as RFC 7644 section 3.5.2 requires. And a
 * deletion is emitted only for something that was really there, so a removal
 * of an attribute the entry never held — or one an earlier operation of the
 * same request added and this one takes back — sends nothing rather than
 * failing the whole modify with noSuchAttribute.
 */
class WorkingEntry {
  private readonly values = new Map<string, string[]>();
  private readonly touched = new Set<string>();

  constructor(private readonly current: AttributesList) {}

  get(attr: string): string[] {
    if (!this.values.has(attr))
      this.values.set(attr, asValues(this.current[attr]));
    return this.values.get(attr) as string[];
  }

  set(attr: string, values: string[]): void {
    this.touched.add(attr);
    this.values.set(attr, values);
  }

  append(attr: string, values: string[]): void {
    const kept = this.get(attr);
    this.set(attr, [...kept, ...values.filter(v => !kept.includes(v))]);
  }

  drop(attr: string, values?: string[]): void {
    if (!values) return this.set(attr, []);
    this.set(
      attr,
      this.get(attr).filter(v => !values.includes(v))
    );
  }

  diff(): ModifyRequest {
    const req: ModifyRequest = {};
    for (const attr of this.touched) {
      const before = asValues(this.current[attr]);
      const after = this.get(attr);
      const added = after.filter(v => !before.includes(v));
      const removed = before.filter(v => !after.includes(v));
      if (added.length === 0 && removed.length === 0) continue;
      if (after.length === 0) {
        // Nothing to delete if it was not there to begin with.
        if (before.length === 0) continue;
        if (!req.delete) req.delete = {};
        (req.delete as AttributesList)[attr] = '';
        continue;
      }
      // Growth of an attribute that already held something stays an LDAP
      // `add` of the new values alone. Sending the whole computed set as a
      // `replace` would carry the snapshot with it: two requests each adding
      // a different value to the same attribute would both write
      // `[snapshot + mine]`, and whichever landed second would silently drop
      // the other's. `add` lets the directory merge them, and turns the one
      // collision that remains — the same value twice — into an error rather
      // than a loss.
      if (removed.length === 0 && before.length > 0) {
        if (!req.add) req.add = {};
        req.add[attr] = added.length === 1 ? added[0] : added;
        continue;
      }
      if (!req.replace) req.replace = {};
      req.replace[attr] = after.length === 1 ? after[0] : after;
    }
    return req;
  }
}

/**
 * Read a SCIM `active` value out of an add or replace operation.
 *
 * A missing value is refused rather than read as `true`: `active` gates
 * account access, and `{"op":"replace","path":"active"}` with nothing to
 * apply is a malformed request, not a request to unlock. `remove` already
 * says "restore the default" explicitly, and is handled by the caller.
 */
function activeValue(value: unknown): boolean {
  const read = readActive(value);
  if (read === undefined) {
    throw scimInvalidValue("PATCH on 'active' requires a value");
  }
  return read;
}

function normalizeOp(op: string): 'add' | 'remove' | 'replace' {
  const lower = op.toLowerCase();
  if (lower === 'add' || lower === 'remove' || lower === 'replace')
    return lower;
  throw scimInvalidValue(`Unknown patch op '${op}'`);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ATTR_NAME_RE = /^[A-Za-z_$:][\w$:]*$/;

function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw scimInvalidPath(`Forbidden attribute name '${key}'`);
  }
}

/**
 * Split a SCIM PATCH path into top / filter / sub components without relying
 * on a lookahead-heavy regex (CodeQL flagged the previous pattern for
 * polynomial backtracking on crafted `$.…` inputs). Each segment is then
 * validated against a strict linear regex.
 */
function parsePath(path: string): {
  top: string;
  sub?: string;
  filter?: string;
} {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) {
    throw scimInvalidPath(`Malformed path '${String(path)}'`);
  }
  let top: string;
  let filter: string | undefined;
  let sub: string | undefined;
  const bracketStart = path.indexOf('[');
  if (bracketStart >= 0) {
    const bracketEnd = path.lastIndexOf(']');
    if (bracketEnd <= bracketStart) {
      throw scimInvalidPath(`Malformed path '${path}'`);
    }
    top = path.slice(0, bracketStart);
    filter = path.slice(bracketStart + 1, bracketEnd);
    const rest = path.slice(bracketEnd + 1);
    if (rest.length > 0) {
      if (rest[0] !== '.') {
        throw scimInvalidPath(`Malformed path '${path}'`);
      }
      sub = rest.slice(1);
    }
  } else {
    const dot = path.indexOf('.');
    if (dot >= 0) {
      top = path.slice(0, dot);
      sub = path.slice(dot + 1);
    } else {
      top = path;
    }
  }
  if (!ATTR_NAME_RE.test(top)) {
    throw scimInvalidPath(`Malformed path '${path}'`);
  }
  assertSafeKey(top);
  if (sub != null) {
    if (!ATTR_NAME_RE.test(sub)) {
      throw scimInvalidPath(`Malformed sub-attribute in '${path}'`);
    }
    assertSafeKey(sub);
  }
  return { top, filter, sub };
}

function coerceValue(v: unknown): string | string[] | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map(x => {
      if (typeof x === 'string') return x;
      if (typeof x === 'number' || typeof x === 'boolean') return String(x);
      if (
        x &&
        typeof x === 'object' &&
        !Array.isArray(x) &&
        'value' in x &&
        (typeof (x as { value: unknown }).value === 'string' ||
          typeof (x as { value: unknown }).value === 'number' ||
          typeof (x as { value: unknown }).value === 'boolean')
      ) {
        return String((x as { value: unknown }).value);
      }
      throw scimInvalidValue(
        `Unsupported array element in PATCH value: ${JSON.stringify(x)}`
      );
    });
  }
  return undefined;
}

/**
 * Apply one PATCH operation to the working entry, in the order it was sent.
 * For member operations on Groups the caller supplies `resolveMemberRef`.
 */
async function applyOperation(
  op: PatchOperation,
  entry: WorkingEntry,
  ctx: PatchContext
): Promise<void> {
  const operation = normalizeOp(op.op);
  const memberAttr = ctx.memberAttribute || 'member';

  // No path: value must be an object with top-level keys
  if (!op.path) {
    // RFC 7644 section 3.5.2.2: "If 'path' is unspecified, the operation
    // fails with HTTP status code 400 and a scimType error code of
    // 'noTarget'." Only add and replace accept an implicit path.
    if (operation === 'remove') {
      throw scimNoTarget("PATCH 'remove' requires a path");
    }
    if (
      op.value == null ||
      typeof op.value !== 'object' ||
      Array.isArray(op.value)
    ) {
      throw scimNoTarget('PATCH without path requires an object value');
    }
    const valueObj = op.value as Record<string, unknown>;
    for (const [scimAttr, v] of Object.entries(valueObj)) {
      await applyOperation({ op: op.op, path: scimAttr, value: v }, entry, ctx);
    }
    return;
  }

  const { top, sub, filter } = parsePath(op.path);

  // Special: members on Groups
  if (top === 'members') {
    const resolveMemberRef = ctx.resolveMemberRef;
    if (!resolveMemberRef) {
      throw scimNoTarget('Member operations require a member resolver');
    }
    const asMemberValues = async (value: unknown): Promise<string[]> => {
      const list = Array.isArray(value) ? value : [value];
      const dns: string[] = [];
      for (const v of list) {
        const memberValue =
          typeof v === 'string'
            ? v
            : typeof v === 'object' && v != null && 'value' in v
              ? String((v as { value: unknown }).value)
              : '';
        if (!memberValue) continue;
        const dn = await resolveMemberRef(memberValue);
        if (dn) dns.push(dn);
      }
      return dns;
    };

    if (operation === 'add') {
      entry.append(memberAttr, await asMemberValues(op.value));
      return;
    }
    if (operation === 'replace') {
      const dns = await asMemberValues(op.value);
      // Same asymmetry as `remove`: a list whose entries all fail to resolve
      // says nothing about what the membership should become, and emptying
      // the group on it would be destroying data on the strength of a
      // lookup miss. This leaves the members alone, as it did before.
      if (dns.length === 0) return;
      entry.set(memberAttr, dns);
      return;
    }
    // remove: either `members[value eq "x"]`, or `members` plus a value list,
    // or bare `members`, which takes them all.
    //
    // Only the bare form means "all". Naming members that resolve to nothing
    // — an identity provider withdrawing a member the directory no longer
    // holds, a filter on something other than `value`, an empty list — is a
    // removal with nothing to remove, not a request to empty the group.
    // Reading the two the same way emptied it and answered 200.
    if (!filter && op.value == null) {
      entry.drop(memberAttr);
      return;
    }
    const fromFilter = filter
      ? (/value\s+eq\s+"([^"]+)"/i.exec(filter)?.[1] ?? '')
      : '';
    const named = [
      ...(fromFilter ? await asMemberValues(fromFilter) : []),
      ...(op.value != null ? await asMemberValues(op.value) : []),
    ];
    entry.drop(memberAttr, named);
    return;
  }

  // Special: `active` on Users. RFC 7643 section 4.1.1 makes it readWrite,
  // and it is the operation every identity provider uses to deactivate an
  // account, but it has no mapping entry: it is the *absence* of the lock
  // attribute. Locking writes the attribute, unlocking removes it.
  if (top === 'active' && ctx.supportsActive) {
    if (sub || filter) {
      throw scimInvalidPath(`'active' has no sub-attribute (got '${op.path}')`);
    }
    const lockAttr = ctx.lockAttribute || DEFAULT_LOCK_ATTRIBUTE;
    // `remove active` restores the default, which is an active account.
    const wanted = operation === 'remove' ? true : activeValue(op.value);
    if (wanted) entry.drop(lockAttr);
    else entry.set(lockAttr, [ctx.lockValue || DEFAULT_LOCK_VALUE]);
    return;
  }

  // Regular SCIM attributes — reject bracket-filtered paths on anything other
  // than `members` (already handled above): without real sub-filter semantics
  // we would silently misapply the operation to the primary value.
  if (filter) {
    throw scimInvalidPath(
      `Complex multi-valued filters are only supported on 'members' (got '${op.path}')`
    );
  }
  const ldapAttr = sub
    ? scimPathToLdapAttribute(`${top}.${sub}`, ctx.mapping)
    : scimPathToLdapAttribute(top, ctx.mapping);

  if (!ldapAttr) {
    throw scimInvalidPath(`Unknown SCIM attribute path '${op.path}'`);
  }

  if (operation === 'remove') {
    entry.drop(ldapAttr);
    return;
  }

  const value = coerceValue(op.value);
  if (value == null) {
    throw scimInvalidValue(`PATCH ${op.op} ${op.path} missing value`);
  }
  const values = Array.isArray(value) ? value : [value];
  if (operation === 'add') entry.append(ldapAttr, values);
  else entry.set(ldapAttr, values);
}

export async function patchToModifyRequest(
  patch: PatchRequest,
  ctx: PatchContext
): Promise<ModifyRequest> {
  if (!patch.Operations || !Array.isArray(patch.Operations)) {
    throw scimInvalidValue('Missing Operations array');
  }
  const entry = new WorkingEntry(ctx.current);
  for (const op of patch.Operations) {
    await applyOperation(op, entry, ctx);
  }
  return entry.diff();
}

/**
 * Apply PATCH to a SCIM resource object in-memory (used for PUT-equivalent
 * or when the resource handler prefers object-level manipulation before
 * falling back to full replace).
 *
 * Returns the mutated resource. Used by tests; the main production path
 * is patchToModifyRequest() → ldap.modify().
 */
export function applyPatchToResource<T extends Record<string, unknown>>(
  resource: T,
  patch: PatchRequest
): T {
  const out: Record<string, unknown> = { ...resource };
  for (const op of patch.Operations) {
    const operation = normalizeOp(op.op);
    if (!op.path) {
      if (
        op.value &&
        typeof op.value === 'object' &&
        !Array.isArray(op.value)
      ) {
        for (const [k, v] of Object.entries(op.value)) {
          assertSafeKey(k);
          out[k] = v;
        }
      }
      continue;
    }
    // parsePath rejects forbidden keys (__proto__, constructor, prototype)
    // so the bracket / dot assignments below are safe from prototype pollution.
    const { top, sub } = parsePath(op.path);
    if (operation === 'remove') {
      if (sub) {
        const obj = out[top];
        if (obj && typeof obj === 'object') {
          delete (obj as Record<string, unknown>)[sub];
        }
      } else {
        delete out[top];
      }
      continue;
    }
    if (sub) {
      const existing = out[top];
      const obj: Record<string, unknown> =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : (Object.create(null) as Record<string, unknown>);
      obj[sub] = op.value;
      out[top] = obj;
    } else {
      out[top] = op.value;
    }
  }
  return out as T;
}
