/**
 * @module plugins/scim/mapping
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Bidirectional mapping between LDAP entries and SCIM resources.
 *
 * Default mappings target inetOrgPerson (User) and groupOfNames (Group),
 * consistent with static/schemas/standard/users.json role semantics.
 *
 * Custom mappings can be loaded from JSON via --scim-user-mapping / --scim-group-mapping.
 */
import fs from 'fs';

import type { AttributesList, AttributeValue } from '../../lib/ldapActions';

import { scimInvalidValue } from './errors';
import {
  type ScimUser,
  type ScimGroup,
  type MappingEntry,
  type ResourceMapping,
  type MultiValued,
  SCHEMA_USER,
  SCHEMA_GROUP,
} from './types';

const OPERATIONAL_ATTRIBUTES = [
  'createTimestamp',
  'modifyTimestamp',
  'entryUUID',
];

export const DEFAULT_USER_MAPPING: ResourceMapping = {
  resourceType: 'User',
  schemas: [SCHEMA_USER],
  entries: [
    { scim: 'userName', ldap: 'uid' },
    { scim: 'externalId', ldap: 'employeeNumber' },
    {
      scim: 'name',
      sub: {
        familyName: 'sn',
        givenName: 'givenName',
        formatted: 'cn',
        middleName: 'initials',
      },
    },
    { scim: 'displayName', ldap: 'displayName' },
    { scim: 'nickName', ldap: 'displayName' },
    { scim: 'title', ldap: 'title' },
    { scim: 'preferredLanguage', ldap: 'preferredLanguage' },
    {
      scim: 'emails',
      ldapPrimary: 'mail',
      ldapSecondary: 'mailAlternateAddress',
      multi: 'array',
    },
    {
      scim: 'phoneNumbers',
      ldapPrimary: 'telephoneNumber',
      ldapSecondary: 'mobile',
      multi: 'array',
    },
  ],
};

/**
 * Group mapping.
 *
 * `externalId` is deliberately absent: RFC 7643 section 3.1 defines it as the
 * *provisioning client's* identifier, so it cannot be served from a
 * server-assigned value. groupOfNames has no attribute meant to hold one
 * either, so the deployment names one with
 * `--scim-group-external-id-attribute` and the entry is added at runtime by
 * `withExternalId()`.
 */
export const DEFAULT_GROUP_MAPPING: ResourceMapping = {
  resourceType: 'Group',
  schemas: [SCHEMA_GROUP],
  entries: [{ scim: 'displayName', ldap: 'cn' }],
};

/**
 * Add the `externalId` entry when the deployment named an attribute to store
 * it in. An entry already present — from a mapping override — wins.
 */
export function withExternalId(
  mapping: ResourceMapping,
  ldapAttribute: string
): ResourceMapping {
  // Tolerate the whitespace a configuration file or environment variable
  // picks up; an attribute name made only of it means "unset", not a name
  // that would fail every later search and write.
  const attribute = (ldapAttribute || '').trim();
  if (!attribute) return mapping;
  if (mapping.entries.some(e => e.scim === 'externalId')) return mapping;
  return {
    ...mapping,
    entries: [...mapping.entries, { scim: 'externalId', ldap: attribute }],
  };
}

function asString(v: AttributeValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const first = v[0];
    return first == null ? undefined : String(first);
  }
  if (Buffer.isBuffer(v)) return v.toString();
  return String(v);
}

/**
 * LDAP GeneralizedTime (RFC 4517 §3.3.13) → SCIM DateTime (RFC 7643 §2.3.5,
 * an `xsd:dateTime`).
 *
 * The directory answers `createTimestamp`/`modifyTimestamp` as
 * `YYYYMMDDHHMMSSZ` (optionally with a fraction, a `+HHMM` offset, or the
 * seconds and minutes omitted). SCIM clients parse `meta.created` as an
 * `xsd:dateTime` and reject anything else, so the raw directory value must not
 * be forwarded as-is.
 *
 * A value that does not look like a GeneralizedTime is returned untouched: a
 * directory may already store an ISO 8601 string, and dropping it would lose
 * more than passing it through.
 */
export function ldapTimeToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2}))?)?(?:[.,](\d+))?(Z|[+-]\d{2}(?:\d{2})?)?$/.exec(
      value
    );
  if (!m) return value;
  const [, year, month, day, hour, minute, second, fraction, zone] = m;

  // The fraction applies to the smallest unit actually present, so `1230.5`
  // is half a minute, not half a second. Fold it into the time of day rather
  // than dropping it, which would answer a timestamp that is simply wrong.
  let extraMs = 0;
  if (fraction) {
    const unitMs = second ? 1000 : minute ? 60000 : 3600000;
    extraMs = Math.round(Number(`0.${fraction}`) * unitMs);
  }
  // The fraction is always smaller than one of its own unit, so this can
  // never carry past the hour that was given: no date arithmetic needed.
  let rest =
    ((Number(hour) * 60 + Number(minute || 0)) * 60 + Number(second || 0)) *
      1000 +
    extraMs;
  const hh = Math.floor(rest / 3600000);
  rest -= hh * 3600000;
  const mm = Math.floor(rest / 60000);
  rest -= mm * 60000;
  const ss = Math.floor(rest / 1000);
  const ms = rest - ss * 1000;

  let offset = 'Z';
  if (zone && zone !== 'Z') {
    offset = `${zone[0]}${zone.slice(1, 3)}:${zone.slice(3, 5) || '00'}`;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  const iso =
    `${year}-${month}-${day}T${pad(hh)}:${pad(mm)}:${pad(ss)}` +
    `${ms ? `.${String(ms).padStart(3, '0')}` : ''}${offset}`;
  // Guard against a syntactically plausible but impossible date (month 13).
  return Number.isNaN(Date.parse(iso)) ? value : iso;
}

function asArray(v: AttributeValue | undefined): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v.map(x => (Buffer.isBuffer(x) ? x.toString() : String(x)));
  }
  if (Buffer.isBuffer(v)) return [v.toString()];
  return [String(v)];
}

export function loadMappingFile(path: string): ResourceMapping | undefined {
  if (!path) return undefined;
  const content = fs.readFileSync(path, 'utf8');
  return JSON.parse(content) as ResourceMapping;
}

/**
 * Build the mapping used at runtime by merging a user-supplied JSON
 * override on top of the default. Override entries replace default
 * entries with the same `scim` key; new entries are appended.
 */
export function mergeMapping(
  base: ResourceMapping,
  override?: ResourceMapping
): ResourceMapping {
  if (!override) return base;
  const map = new Map<string, MappingEntry>();
  for (const e of base.entries) map.set(e.scim, e);
  for (const e of override.entries) map.set(e.scim, e);
  return { ...base, entries: Array.from(map.values()) };
}

export interface MappingContext {
  /** 'rdn' (default), 'entryUUID', or any LDAP attribute name */
  idAttribute: string;
  rdnAttribute: string;
  resourceType: 'User' | 'Group';
  baseUrl?: string;
  scimPrefix: string;
  /**
   * LDAP attribute whose *presence* marks the account as locked, and the
   * value written to lock it. See `DEFAULT_LOCK_ATTRIBUTE`.
   */
  lockAttribute?: string;
  lockValue?: string;
}

/**
 * SCIM `active` (RFC 7643 section 4.1.1) has no direct LDAP equivalent. We
 * model it on the presence of one attribute: present means locked, absent
 * means active.
 *
 * The default is the ppolicy overlay's `pwdAccountLockedTime`, whose
 * conventional "locked forever" value is a GeneralizedTime in the distant
 * past. A directory without that overlay points
 * `--scim-user-lock-attribute` / `--scim-user-lock-value` somewhere else
 * (`nsAccountLock` / `TRUE`, for instance).
 */
export const DEFAULT_LOCK_ATTRIBUTE = 'pwdAccountLockedTime';
export const DEFAULT_LOCK_VALUE = '000001010000Z';

/** An LDAP attribute name, per RFC 4512 section 2.5 (no options accepted). */
const LDAP_ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Settle the lock configuration, or refuse to start.
 *
 * Two ways to get a deployment that answers 200 to every deactivation while
 * the directory locks nothing:
 *
 * - naming an attribute without its value. `000001010000Z` is the ppolicy
 *   convention and means nothing to `nsAccountLock`, which 389-ds honours
 *   only for the string `TRUE` — so every deactivation would be written,
 *   read back as `active: false`, and the account would keep binding.
 * - a name that is not an attribute name. It is interpolated into the
 *   emitted LDAP filter for `active eq …`, where a metacharacter makes
 *   every list either malformed or quietly wrong.
 *
 * Both are operator mistakes rather than attacks, and both are silent. This
 * turns them into a startup failure.
 */
export function resolveLockConfig(
  attribute: string,
  value: string
): { attribute: string; value: string } {
  const attr = (attribute || '').trim() || DEFAULT_LOCK_ATTRIBUTE;
  if (!LDAP_ATTRIBUTE_NAME.test(attr)) {
    throw new Error(
      `--scim-user-lock-attribute must be an LDAP attribute name, got '${attr}'`
    );
  }
  const val = (value || '').trim();
  if (val) return { attribute: attr, value: val };
  // LDAP attribute descriptions are case-insensitive (RFC 4512 section 2.5),
  // so `pwdaccountlockedtime` is the same attribute and must keep working.
  if (attr.toLowerCase() === DEFAULT_LOCK_ATTRIBUTE.toLowerCase()) {
    // The ppolicy overlay's own "locked forever" convention.
    return { attribute: attr, value: DEFAULT_LOCK_VALUE };
  }
  throw new Error(
    `--scim-user-lock-attribute is '${attr}', so --scim-user-lock-value must ` +
      `say what marks an account locked (for ${attr} on 389-ds, 'TRUE'). ` +
      `The default '${DEFAULT_LOCK_VALUE}' only means anything to ` +
      `${DEFAULT_LOCK_ATTRIBUTE}.`
  );
}

/**
 * Read a SCIM `active` value, wherever it came from.
 *
 * `undefined` means the body did not mention it — which is not the same as
 * `true`. Only a boolean, or the two canonical strings some providers send
 * instead, are accepted: guessing at `"0"`, `null` or `1` would let a
 * deprovisioning request be executed as a re-activation, and answer 200
 * doing it. The one rule lives here so POST, PUT, PATCH and the filter
 * translator cannot drift apart.
 */
export function readActive(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  throw scimInvalidValue(`Cannot read ${JSON.stringify(value)} as active`);
}

/** Is this entry locked, per the configured lock attribute? */
export function isLocked(entry: AttributesList, ctx: MappingContext): boolean {
  const raw = entry[ctx.lockAttribute || DEFAULT_LOCK_ATTRIBUTE];
  if (raw == null) return false;
  // A directory may answer an empty array for an attribute it does not hold.
  if (Array.isArray(raw)) return raw.length > 0;
  return String(raw).length > 0;
}

/** Resolve the SCIM id for an LDAP entry, per configuration. */
export function resolveScimId(
  entry: AttributesList,
  ctx: MappingContext
): string | undefined {
  if (ctx.idAttribute === 'rdn') {
    return asString(entry[ctx.rdnAttribute]);
  }
  const v = asString(entry[ctx.idAttribute]);
  return v ?? asString(entry[ctx.rdnAttribute]);
}

export function buildLocation(
  id: string,
  ctx: MappingContext
): string | undefined {
  if (!ctx.baseUrl) return undefined;
  const endpoint = ctx.resourceType === 'User' ? 'Users' : 'Groups';
  return `${ctx.baseUrl.replace(/\/$/, '')}${ctx.scimPrefix}/${endpoint}/${encodeURIComponent(id)}`;
}

export function ldapToScimUser(
  entry: AttributesList,
  mapping: ResourceMapping,
  ctx: MappingContext
): ScimUser {
  const out: ScimUser = { schemas: [SCHEMA_USER] };
  const id = resolveScimId(entry, ctx);
  if (id) out.id = id;

  for (const m of mapping.entries) {
    if (m.sub) {
      const sub: Record<string, string> = {};
      for (const [scimKey, ldapKey] of Object.entries(m.sub)) {
        const v = asString(entry[ldapKey]);
        if (v != null) sub[scimKey] = v;
      }
      if (Object.keys(sub).length > 0) {
        (out as Record<string, unknown>)[m.scim] = sub;
      }
      continue;
    }
    if (m.ldapPrimary || m.ldapSecondary) {
      const arr: MultiValued[] = [];
      if (m.ldapPrimary) {
        const primary = asString(entry[m.ldapPrimary]);
        if (primary != null) arr.push({ value: primary, primary: true });
      }
      if (m.ldapSecondary) {
        for (const v of asArray(entry[m.ldapSecondary])) {
          arr.push({ value: v });
        }
      }
      if (arr.length > 0) (out as Record<string, unknown>)[m.scim] = arr;
      continue;
    }
    if (m.ldap) {
      if (m.multi === 'array') {
        const arr = asArray(entry[m.ldap]);
        if (arr.length > 0) (out as Record<string, unknown>)[m.scim] = arr;
      } else {
        const v = asString(entry[m.ldap]);
        if (v != null) (out as Record<string, unknown>)[m.scim] = v;
      }
    }
  }

  // active: RFC 7643 section 4.1.1 — locked accounts answer false
  out.active = !isLocked(entry, ctx);

  // meta
  if (id) {
    out.meta = {
      resourceType: 'User',
      created: ldapTimeToIso(asString(entry['createTimestamp'])),
      lastModified: ldapTimeToIso(asString(entry['modifyTimestamp'])),
      location: buildLocation(id, ctx),
    };
  }
  return out;
}

/**
 * Convert SCIM User body → LDAP attributes list.
 * The RDN attribute is set from `userName` (or explicit `id`).
 * Returns { rdn, attributes } so the caller can build the DN.
 */
export function scimUserToLdap(
  user: ScimUser,
  mapping: ResourceMapping,
  ctx: MappingContext,
  objectClass: string[]
): { rdn: string; attributes: AttributesList; active?: boolean } {
  const attributes: AttributesList = { objectClass };
  const rdnValue = user.userName || user.id || '';

  for (const m of mapping.entries) {
    if (m.readOnly || m.operational) continue;
    const value = (user as Record<string, unknown>)[m.scim];
    if (value == null) continue;
    if (m.sub && typeof value === 'object') {
      for (const [scimKey, ldapKey] of Object.entries(m.sub)) {
        const sv = (value as Record<string, unknown>)[scimKey];
        if (typeof sv === 'string' && sv.length > 0) attributes[ldapKey] = sv;
      }
      continue;
    }
    if (m.ldapPrimary || m.ldapSecondary) {
      if (!Array.isArray(value)) continue;
      const mv = value as MultiValued[];
      const primary = mv.find(v => v.primary === true) || mv[0];
      const others = mv.filter(v => v !== primary);
      if (m.ldapPrimary && primary && primary.value) {
        attributes[m.ldapPrimary] = primary.value;
      }
      if (m.ldapSecondary && others.length > 0) {
        attributes[m.ldapSecondary] = others.map(v => v.value).filter(Boolean);
      }
      continue;
    }
    if (m.ldap) {
      if (Array.isArray(value)) {
        attributes[m.ldap] = value.map(v => String(v));
      } else if (typeof value === 'string' || typeof value === 'number') {
        attributes[m.ldap] = String(value);
      }
    }
  }

  // `active` is not a mapping entry: false writes the lock attribute. True,
  // and the absence of the field, are answered by the caller — only it knows
  // whether the entry currently holds a lock and whether the body claimed
  // anything about it at all.
  const active = readActive(user.active);
  if (active === false) {
    attributes[ctx.lockAttribute || DEFAULT_LOCK_ATTRIBUTE] =
      ctx.lockValue || DEFAULT_LOCK_VALUE;
  }

  // Ensure required inetOrgPerson attributes have sensible defaults
  if (!attributes.cn && rdnValue) attributes.cn = rdnValue;
  if (!attributes.sn) {
    const sn = user.name?.familyName || user.displayName || rdnValue;
    if (sn) attributes.sn = sn;
  }

  // Set RDN attribute value explicitly
  return { rdn: rdnValue, attributes, active };
}

export function ldapToScimGroup(
  entry: AttributesList,
  mapping: ResourceMapping,
  ctx: MappingContext,
  memberResolver?: (dn: string) => MultiValued | undefined
): ScimGroup {
  const out: ScimGroup = { schemas: [SCHEMA_GROUP] };
  const id = resolveScimId(entry, ctx);
  if (id) out.id = id;

  for (const m of mapping.entries) {
    if (!m.ldap) continue;
    const raw = entry[m.ldap];
    if (raw == null) continue;
    if (m.multi === 'array') {
      const arr = asArray(raw);
      if (arr.length > 0) (out as Record<string, unknown>)[m.scim] = arr;
    } else {
      const v = asString(raw);
      if (v != null) (out as Record<string, unknown>)[m.scim] = v;
    }
  }

  // Resolve members from LDAP `member` DN list
  const memberDns = asArray(entry['member']);
  const members: MultiValued[] = [];
  for (const dn of memberDns) {
    if (!dn) continue;
    if (memberResolver) {
      const resolved = memberResolver(dn);
      if (resolved) members.push(resolved);
    } else {
      members.push({ value: dn, type: 'User' });
    }
  }
  if (members.length > 0) out.members = members;

  if (id) {
    out.meta = {
      resourceType: 'Group',
      created: ldapTimeToIso(asString(entry['createTimestamp'])),
      lastModified: ldapTimeToIso(asString(entry['modifyTimestamp'])),
      location: buildLocation(id, ctx),
    };
  }
  return out;
}

/**
 * Convert SCIM Group → LDAP attributes (members excluded; they're
 * resolved separately to DNs by the handler).
 */
export function scimGroupToLdap(
  group: ScimGroup,
  mapping: ResourceMapping,
  objectClass: string[]
): { rdn: string; attributes: AttributesList } {
  const attributes: AttributesList = { objectClass };
  const rdnValue = group.displayName || group.id || '';
  for (const m of mapping.entries) {
    if (m.readOnly || m.operational) continue;
    if (!m.ldap) continue;
    const v = (group as Record<string, unknown>)[m.scim];
    if (v == null) continue;
    if (Array.isArray(v)) {
      attributes[m.ldap] = v.map(x =>
        typeof x === 'string' ? x : JSON.stringify(x)
      );
    } else if (typeof v === 'string' || typeof v === 'number') {
      attributes[m.ldap] = String(v);
    }
  }
  return { rdn: rdnValue, attributes };
}

/**
 * List of LDAP attributes to request from the directory so all
 * mapped SCIM attributes can be populated.
 */
export function requiredLdapAttributes(
  mapping: ResourceMapping,
  extra: string[] = []
): string[] {
  const attrs = new Set<string>([
    'objectClass',
    ...OPERATIONAL_ATTRIBUTES,
    ...extra,
  ]);
  for (const m of mapping.entries) {
    if (m.ldap) attrs.add(m.ldap);
    if (m.ldapPrimary) attrs.add(m.ldapPrimary);
    if (m.ldapSecondary) attrs.add(m.ldapSecondary);
    if (m.sub) for (const v of Object.values(m.sub)) attrs.add(v);
  }
  return Array.from(attrs);
}

/**
 * Given a SCIM attribute path like "emails.value" or "name.familyName",
 * return the corresponding LDAP attribute name (used by filter parser).
 * Returns undefined if the path is not mapped.
 */
export function scimPathToLdapAttribute(
  path: string,
  mapping: ResourceMapping
): string | undefined {
  // Special: id, userName, displayName, active
  const top = path.split('.')[0];
  const sub = path.includes('.') ? path.split('.').slice(1).join('.') : '';

  for (const m of mapping.entries) {
    if (m.scim !== top) continue;
    if (m.sub && sub) {
      return m.sub[sub];
    }
    // Multi-valued: emails.value → primary attr
    if ((m.ldapPrimary || m.ldapSecondary) && (sub === 'value' || !sub)) {
      return m.ldapPrimary || m.ldapSecondary;
    }
    if (m.ldap) return m.ldap;
  }
  return undefined;
}
