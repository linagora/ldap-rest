/**
 * @module plugins/scim/projection
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Partial resource representations (RFC 7644 §3.9).
 *
 * A client narrows what comes back with `attributes` (return only these) or
 * `excludedAttributes` (return the default set without these). The two are
 * mutually exclusive, and neither can drop an attribute whose `returned`
 * characteristic is `always` — `id` and `schemas` (RFC 7643 §7).
 *
 * Both accept standard attribute notation, so `name.familyName` and
 * `emails.value` narrow a complex or multi-valued attribute to the named
 * sub-attributes rather than dropping it whole. A path may carry the core
 * schema URN as a prefix, which is stripped; an extension URN is a key of the
 * resource in its own right and is matched as-is.
 */
import { scimInvalidValue } from './errors';
import { SCHEMA_USER, SCHEMA_GROUP } from './types';

/** Attributes RFC 7643 §7 marks `returned: always`. */
const ALWAYS_RETURNED = ['schemas', 'id'];

export interface ProjectionQuery {
  attributes?: string[];
  excludedAttributes?: string[];
}

/** `urn:…:core:2.0:User:userName` → `userName`; other URNs are left alone. */
function stripCoreUrn(path: string): string {
  for (const urn of [SCHEMA_USER, SCHEMA_GROUP]) {
    if (path.toLowerCase().startsWith(`${urn.toLowerCase()}:`)) {
      return path.slice(urn.length + 1);
    }
  }
  return path;
}

/**
 * Group attribute paths by their first segment. A top-level path present
 * without a sub-attribute wins over its own sub-attribute paths: asking for
 * `name` and `name.givenName` means the whole of `name`.
 */
function groupPaths(paths: string[]): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>();
  for (const raw of paths) {
    const path = stripCoreUrn(raw.trim());
    if (!path) continue;
    // Only split on a dot that is not inside a URN.
    const dot = path.startsWith('urn:')
      ? path.indexOf('.', path.lastIndexOf(':'))
      : path.indexOf('.');
    const top = (dot > 0 ? path.slice(0, dot) : path).toLowerCase();
    const sub = dot > 0 ? path.slice(dot + 1).toLowerCase() : '';
    if (!sub) {
      out.set(top, null); // whole attribute
      continue;
    }
    const existing = out.get(top);
    if (existing === null) continue; // already whole
    if (existing) existing.add(sub);
    else out.set(top, new Set([sub]));
  }
  return out;
}

/** Keep only `subs` of a complex value, or of each element of a multi-valued one. */
function narrow(value: unknown, subs: Set<string>): unknown {
  const pick = (obj: Record<string, unknown>): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (subs.has(k.toLowerCase())) kept[k] = v;
    }
    return kept;
  };
  if (Array.isArray(value)) {
    const mapped = (value as unknown[]).map(v =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? pick(v as Record<string, unknown>)
        : v
    );
    // An element left with nothing is noise, not a value.
    return mapped.filter(
      v => !(v && typeof v === 'object' && Object.keys(v).length === 0)
    );
  }
  if (value && typeof value === 'object') {
    return pick(value as Record<string, unknown>);
  }
  // A sub-attribute was asked of a simple attribute: return it whole rather
  // than nothing, which is what the client meant.
  return value;
}

/** Drop `subs` from a complex value, or from each element of a multi-valued one. */
function without(value: unknown, subs: Set<string>): unknown {
  const drop = (obj: Record<string, unknown>): Record<string, unknown> => {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!subs.has(k.toLowerCase())) kept[k] = v;
    }
    return kept;
  };
  if (Array.isArray(value)) {
    return (value as unknown[]).map(v =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? drop(v as Record<string, unknown>)
        : v
    );
  }
  if (value && typeof value === 'object') {
    return drop(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Raise when both parameters are given: RFC 7644 §3.9 makes them mutually
 * exclusive, and honouring one silently would hide the mistake.
 */
export function assertProjection(query: ProjectionQuery): void {
  if (query.attributes?.length && query.excludedAttributes?.length) {
    throw scimInvalidValue(
      "'attributes' and 'excludedAttributes' are mutually exclusive (RFC 7644 section 3.9)"
    );
  }
}

/** Apply `attributes` / `excludedAttributes` to one resource. */
export function projectResource<T extends Record<string, unknown>>(
  resource: T,
  query: ProjectionQuery
): T {
  if (query.attributes?.length) {
    const wanted = groupPaths([...ALWAYS_RETURNED, ...query.attributes]);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(resource)) {
      if (!wanted.has(key.toLowerCase())) continue;
      const subs = wanted.get(key.toLowerCase());
      out[key] = subs ? narrow(value, subs) : value;
    }
    return out as T;
  }

  if (query.excludedAttributes?.length) {
    const unwanted = groupPaths(query.excludedAttributes);
    const always = new Set(ALWAYS_RETURNED);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(resource)) {
      const lower = key.toLowerCase();
      const subs = unwanted.get(lower);
      if (subs === undefined) {
        out[key] = value;
        continue;
      }
      // `returned: always` survives an exclusion.
      if (subs === null) {
        if (always.has(lower)) out[key] = value;
        continue;
      }
      out[key] = without(value, subs);
    }
    return out as T;
  }

  return resource;
}

/** Apply the projection to every resource of a ListResponse. */
export function projectList<
  T extends Record<string, unknown>,
  L extends { Resources: T[] },
>(list: L, query: ProjectionQuery): L {
  if (!query.attributes?.length && !query.excludedAttributes?.length) {
    return list;
  }
  return {
    ...list,
    Resources: list.Resources.map(r => projectResource(r, query)),
  };
}
