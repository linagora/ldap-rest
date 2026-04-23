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
 *  - implicit path (op.value is an object)
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
import { scimPathToLdapAttribute } from './mapping';

export interface PatchContext {
  mapping: ResourceMapping;
  /** For Groups: resolve SCIM member value (id or $ref) → LDAP DN. Async. */
  resolveMemberRef?: (value: string) => Promise<string | undefined>;
  /** The LDAP attribute holding members, default 'member'. */
  memberAttribute?: string;
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

function mergeAttr(
  target: AttributesList,
  attr: string,
  value: string | string[]
): void {
  const existing = target[attr];
  if (existing == null) {
    target[attr] = value;
    return;
  }
  const asArr = (v: AttributeValue): string[] =>
    Array.isArray(v)
      ? v.map(x => (typeof x === 'string' ? x : x.toString()))
      : [typeof v === 'string' ? v : v.toString()];
  const combined = [
    ...asArr(existing),
    ...(Array.isArray(value) ? value : [value]),
  ];
  target[attr] = combined;
}

/**
 * Apply a PATCH operation by mutating an in-progress ModifyRequest.
 * For member-related ops on Groups, caller must supply resolveMemberRef.
 */
async function applyOperation(
  op: PatchOperation,
  req: ModifyRequest,
  ctx: PatchContext
): Promise<void> {
  const operation = normalizeOp(op.op);
  const memberAttr = ctx.memberAttribute || 'member';

  // No path: value must be an object with top-level keys
  if (!op.path) {
    if (
      op.value == null ||
      typeof op.value !== 'object' ||
      Array.isArray(op.value)
    ) {
      throw scimNoTarget('PATCH without path requires an object value');
    }
    const valueObj = op.value as Record<string, unknown>;
    for (const [scimAttr, v] of Object.entries(valueObj)) {
      await applyOperation({ op: op.op, path: scimAttr, value: v }, req, ctx);
    }
    return;
  }

  const { top, sub, filter } = parsePath(op.path);

  // Special: members on Groups
  if (top === 'members') {
    if (!ctx.resolveMemberRef) {
      throw scimNoTarget('Member operations require a member resolver');
    }
    if (operation === 'add') {
      const values = Array.isArray(op.value) ? op.value : [op.value];
      const dns: string[] = [];
      for (const v of values) {
        const memberValue =
          typeof v === 'string'
            ? v
            : typeof v === 'object' && v != null && 'value' in v
              ? String((v as { value: unknown }).value)
              : '';
        if (!memberValue) continue;
        const dn = await ctx.resolveMemberRef(memberValue);
        if (dn) dns.push(dn);
      }
      if (dns.length > 0) {
        if (!req.add) req.add = {};
        mergeAttr(req.add, memberAttr, dns);
      }
      return;
    }
    if (operation === 'remove') {
      // Two cases:
      //  - path "members" with no filter but with `value` listing members → remove those
      //  - path 'members[value eq "abc"]' → filter identifies members
      const collectFromValue = (): string[] => {
        if (op.value == null) return [];
        const arr = Array.isArray(op.value) ? op.value : [op.value];
        return arr
          .map(v =>
            typeof v === 'string'
              ? v
              : typeof v === 'object' && v != null && 'value' in v
                ? String((v as { value: unknown }).value)
                : ''
          )
          .filter(Boolean);
      };
      const collectFromFilter = (): string[] => {
        if (!filter) return [];
        const fm = /value\s+eq\s+"([^"]+)"/i.exec(filter);
        return fm ? [fm[1]] : [];
      };
      const ids = [...collectFromFilter(), ...collectFromValue()];
      const dns: string[] = [];
      for (const id of ids) {
        const dn = await ctx.resolveMemberRef(id);
        if (dn) dns.push(dn);
      }
      if (dns.length > 0) {
        if (!req.delete) req.delete = {};
        if (Array.isArray(req.delete)) {
          // Not expected: would have been initialized as array elsewhere.
          req.delete = { [memberAttr]: dns };
        } else {
          mergeAttr(req.delete, memberAttr, dns);
        }
      } else if (!filter && !op.value) {
        // Remove all members
        if (!req.delete) req.delete = {};
        if (Array.isArray(req.delete)) {
          req.delete.push(memberAttr);
        } else {
          req.delete[memberAttr] = '';
        }
      }
      return;
    }
    if (operation === 'replace') {
      // replace: remove existing members, add new
      // ldapts modify with { replace: { member: [...] } } → same semantic
      const values = Array.isArray(op.value) ? op.value : [op.value];
      const dns: string[] = [];
      for (const v of values) {
        const memberValue =
          typeof v === 'string'
            ? v
            : typeof v === 'object' && v != null && 'value' in v
              ? String((v as { value: unknown }).value)
              : '';
        if (!memberValue) continue;
        const dn = await ctx.resolveMemberRef(memberValue);
        if (dn) dns.push(dn);
      }
      if (dns.length > 0) {
        if (!req.replace) req.replace = {};
        req.replace[memberAttr] = dns;
      }
      return;
    }
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
    if (!req.delete) req.delete = {};
    if (Array.isArray(req.delete)) {
      req.delete.push(ldapAttr);
    } else {
      req.delete[ldapAttr] = '';
    }
    return;
  }

  const value = coerceValue(op.value);
  if (value == null) {
    throw scimInvalidValue(`PATCH ${op.op} ${op.path} missing value`);
  }

  if (operation === 'add') {
    if (!req.add) req.add = {};
    mergeAttr(req.add, ldapAttr, value);
    return;
  }
  if (operation === 'replace') {
    if (!req.replace) req.replace = {};
    req.replace[ldapAttr] = value;
    return;
  }
}

export async function patchToModifyRequest(
  patch: PatchRequest,
  ctx: PatchContext
): Promise<ModifyRequest> {
  if (!patch.Operations || !Array.isArray(patch.Operations)) {
    throw scimInvalidValue('Missing Operations array');
  }
  const req: ModifyRequest = {};
  for (const op of patch.Operations) {
    await applyOperation(op, req, ctx);
  }
  return req;
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
