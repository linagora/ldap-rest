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
 *  - multi-valued paths: "emails", "emails[primary eq true]"
 *  - implicit path (op.value is an object)
 *
 * Multi-valued member operations for Groups are handled by a caller-provided
 * hook (resolveMemberRef) because they require a lookup (SCIM id → DN).
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

function parsePath(path: string): {
  top: string;
  sub?: string;
  filter?: string;
} {
  // "emails[primary eq true].value" or "emails" or "name.familyName"
  const m = /^([A-Za-z_$:][\w.$:]*?)(?:\[(.+?)\])?(?:\.(.+))?$/.exec(path);
  if (!m) throw scimInvalidPath(`Malformed path '${path}'`);
  return { top: m[1], filter: m[2], sub: m[3] };
}

function coerceValue(v: unknown): string | string[] | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map(x => (typeof x === 'string' ? x : String(x)));
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

  // Regular SCIM attributes
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
        for (const [k, v] of Object.entries(op.value)) out[k] = v;
      }
      continue;
    }
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
      const obj = (out[top] as Record<string, unknown>) || {};
      obj[sub] = op.value;
      out[top] = obj;
    } else {
      out[top] = op.value;
    }
  }
  return out as T;
}
