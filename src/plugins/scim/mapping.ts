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

export const DEFAULT_GROUP_MAPPING: ResourceMapping = {
  resourceType: 'Group',
  schemas: [SCHEMA_GROUP],
  entries: [
    { scim: 'displayName', ldap: 'cn' },
    {
      scim: 'externalId',
      ldap: 'entryUUID',
      operational: true,
      readOnly: true,
    },
  ],
};

function asString(v: AttributeValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const first = v[0];
    return first == null ? undefined : String(first);
  }
  if (Buffer.isBuffer(v)) return v.toString();
  return String(v);
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

  // active: true if pwdAccountLockedTime is not set (reasonable default)
  out.active = entry['pwdAccountLockedTime'] == null;

  // meta
  if (id) {
    out.meta = {
      resourceType: 'User',
      created: asString(entry['createTimestamp']),
      lastModified: asString(entry['modifyTimestamp']),
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
): { rdn: string; attributes: AttributesList } {
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

  // Ensure required inetOrgPerson attributes have sensible defaults
  if (!attributes.cn && rdnValue) attributes.cn = rdnValue;
  if (!attributes.sn) {
    const sn = user.name?.familyName || user.displayName || rdnValue;
    if (sn) attributes.sn = sn;
  }

  // Set RDN attribute value explicitly
  return { rdn: rdnValue, attributes };
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
      created: asString(entry['createTimestamp']),
      lastModified: asString(entry['modifyTimestamp']),
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
export function requiredLdapAttributes(mapping: ResourceMapping): string[] {
  const attrs = new Set<string>(['objectClass', ...OPERATIONAL_ATTRIBUTES]);
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
