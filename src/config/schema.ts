import type { AttributeValue } from '../lib/ldapActions';
import { BadRequestError } from '../lib/errors';

/**
 * Scalar and container types an entity schema may declare.
 *
 * `pointer` is a DN reference validated against `branch`; `date` is an LDAP
 * generalized time (`yyyyMMddHHmmss[.SSS]Z`).
 */
export type SchemaAttributeType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'array'
  | 'pointer';

/**
 * Semantic role of an attribute: what it *means*, independent of the concrete
 * LDAP attribute holding it. Core code is written against roles so that a
 * deployment with a different directory layout reuses it unchanged — the name
 * of the attribute and the values it takes are configuration.
 *
 * The type is a plain string: the list below is what the core itself looks
 * for, and a deployment is free to add its own for its plugins.
 *
 * | Role               | Meaning                                              |
 * | ------------------ | ---------------------------------------------------- |
 * | `identifier`       | RDN value of the entry                               |
 * | `displayName`      | Human-readable name                                  |
 * | `primaryEmail`     | Main mail address                                    |
 * | `emailAliases`     | Further addresses of the same mailbox                |
 * | `emailQuota`       | Mailbox size limit, in bytes                         |
 * | `organizationLink` | DN of the organization the entry belongs to          |
 * | `organizationPath` | Human-readable path of that organization             |
 * | `members`          | DNs of the members of a group                        |
 * | `owners`           | DNs allowed to write to a restricted group           |
 * | `accountStatus`    | Lifecycle state of an account (enabled / disabled…)  |
 * | `password`         | Credential                                           |
 * | `passwordReset`    | Flag forcing a password change at next login         |
 * | `accountExpiry`    | Date after which the account is to be removed        |
 * | `domainLink`       | DNs of the mail domains an organization may use      |
 * | `domainName`       | Domain name carried by a domain entry                |
 */
export type SchemaRole = string;

/**
 * A piece of text a client shows, in one or several languages.
 *
 * A plain string is the text itself. A map is keyed by language tag, and a
 * client picks the closest one it can:
 *
 * ```json
 * "label": { "en": "Department", "fr": "Département" }
 * ```
 *
 * These words belong to the deployment, not to the product — they name *its*
 * entities and attributes — so their translations belong in its schemas
 * rather than in a catalogue shipped with the code.
 */
export type LocalizedText = string | Record<string, string>;

/** Roles the core itself looks for. See {@link SchemaRole}. */
export const CORE_ROLES = [
  'identifier',
  'displayName',
  'primaryEmail',
  'emailAliases',
  'emailQuota',
  'organizationLink',
  'organizationPath',
  'members',
  'owners',
  'accountStatus',
  'password',
  'passwordReset',
  'accountExpiry',
  'domainLink',
  'domainName',
] as const;

/**
 * How a uniqueness constraint is evaluated.
 *
 * By default the value must be unique among the entries of the entity's own
 * branch. `branches` widens the search to a shared namespace — a mail address
 * belongs to accounts *and* to distribution lists — and `attributes` names the
 * other attributes that hold values of that same namespace.
 */
export interface UniqueConstraint {
  /**
   * Extra branches searched besides the entity's own base. Each entry may use
   * the `__ldap_base__` placeholder, like `branch`.
   */
  branches?: string[];
  /**
   * Other attributes sharing the value namespace, searched alongside the
   * attribute itself (e.g. `mailAlternateAddress` for `mail`).
   */
  attributes?: string[];
  /**
   * Value exempted from the check. A directory may use a placeholder for
   * non-individual entries (a shared payroll number, say); that value is
   * allowed to repeat.
   */
  sentinel?: string;
  /** Extra LDAP filter narrowing the search, e.g. `(objectClass=twakeAccount)` */
  filter?: string;
}

/**
 * Derivation of a generated attribute from another attribute of the same
 * entry. Used for identifiers built from the mail address, where the client
 * never supplies the value.
 */
export interface GeneratedFrom {
  /** Source attribute, e.g. `mail` */
  attribute: string;
  /**
   * Regex whose first capturing group is the generated value. Applied to the
   * source value; when it does not match, the whole source value is used.
   */
  extract?: string;
  /** Lowercase the result */
  lowercase?: boolean;
  /**
   * Characters to drop from the extracted value, as an extended regular
   * expression. A mail local part may legally hold `+`, `'` or `!`, which an
   * identifier charset usually refuses; without this the entry becomes
   * uncreatable, since the client may not send the generated attribute
   * either. `[^a-zA-Z0-9._-]` keeps what a `uid` accepts.
   */
  strip?: string;
  /**
   * What to do when the generated value is already taken. `error` (the
   * default) refuses the creation; `suffix` appends `-2`, `-3`, … until a free
   * value is found.
   */
  onCollision?: 'error' | 'suffix';
  /** Recompute when the source attribute changes (renames the entry) */
  regenerateOnChange?: boolean;
}

export interface SchemaAttribute {
  type: SchemaAttributeType;
  items?: {
    type: string;
    test?: string | RegExp;
    hint?: string;
    branch?: string[];
  };
  default?: AttributeValue;
  required?: boolean;
  test?: string | RegExp;
  /**
   * Plain-language description of `test`, shown to the user *before* they get
   * a value wrong — "Expected pattern 999 9999". It travels with the
   * schema so the pattern and its explanation cannot drift apart, and so a
   * client never has to hardcode either.
   */
  hint?: string;
  branch?: string[];
  fixed?: boolean;
  /** Semantic role(s) — see {@link SchemaRole} */
  role?: SchemaRole | SchemaRole[];
  /**
   * Computed server-side. Refused when a client supplies it; still writable by
   * the core and by plugins.
   */
  generated?: boolean;
  /** How a `generated` value is derived from another attribute */
  generatedFrom?: GeneratedFrom;
  /**
   * Operational or derived attribute: refused in input and never written.
   * `memberOf` is the archetype — membership is driven from the group side.
   */
  readOnly?: boolean;
  /**
   * Never returned to a client, though it may still be written. Covers the
   * write-only attributes of a password reset.
   */
  neverReturn?: boolean;
  /** Value must be unique; `true` means "unique within this entity" */
  unique?: boolean | UniqueConstraint;
  /**
   * Canonicalisation applied to an incoming value before it is stored.
   *
   * `byteSize` reads a human-readable size (`5GB`, `500MB`, `2048`) and stores
   * the number of bytes, so the same value means the same thing whether it
   * arrived on a creation or an update.
   */
  normalize?: 'byteSize';
  /**
   * Named states of a lifecycle attribute, mapping a semantic name the API
   * speaks (`enabled`, `disabled`) to the concrete value this directory
   * stores. What "disabled" *is* — a DN in a nomenclature, a string, a
   * boolean — is a property of the deployment, never of the code.
   */
  states?: Record<string, AttributeValue>;
  /**
   * For a `pointer`: refuse to delete the entry it points at while any entry
   * still references it. `ignore` (the default) leaves the reference dangling.
   */
  referentialIntegrity?: 'restrict' | 'ignore';
  /**
   * For a `members`-role attribute: refuse to delete the entry while it still
   * has members. The placeholder member some directories need to keep a
   * `groupOfNames` valid (`--group-dummy-user`) does not count.
   */
  deleteGuard?: 'nonEmpty';
  /**
   * For a mail attribute: which set of domains the address must belong to.
   *
   * `organization` walks up from the entry's organization, collecting the
   * domains declared on it and on each of its ancestors; `directory` accepts
   * any domain declared anywhere in the directory. When no domain is declared
   * at all, any address passes.
   */
  mailDomainScope?: 'organization' | 'directory';
  /**
   * Accept a subdomain of an authorised domain — `list@lists.example.org`
   * under `example.org`. Off by default: the domain must match exactly.
   */
  allowSubdomains?: boolean;
  /** Grouping hint for a form, e.g. `Mailbox Settings` */
  group?: string;
  /** Name a client shows for this attribute, in one or several languages */
  label?: LocalizedText;
}

export interface Schema {
  strict: boolean;
  attributes: {
    [key: string]: SchemaAttribute;
  };
}

/**
 * Tell whether an attribute carries a given semantic role.
 *
 * @param attr attribute definition
 * @param role role to look for
 * @returns true when the attribute declares that role
 */
export function hasRole(
  attr: SchemaAttribute | undefined,
  role: SchemaRole
): boolean {
  if (!attr?.role) return false;
  return Array.isArray(attr.role)
    ? attr.role.includes(role)
    : attr.role === role;
}

/**
 * Find the attribute of a schema carrying a given semantic role.
 *
 * This is the lookup that keeps core code free of concrete attribute names:
 * `roleAttribute(schema, 'accountStatus')` returns `twakeAccountStatus` for a
 * Twake directory and whatever another deployment chose for its own.
 *
 * @param schema entity schema
 * @param role role to look for
 * @returns attribute name, or undefined when no attribute declares that role
 */
export function roleAttribute(
  schema: Schema | undefined,
  role: SchemaRole
): string | undefined {
  if (!schema) return undefined;
  for (const [name, attr] of Object.entries(schema.attributes)) {
    if (hasRole(attr, role)) return name;
  }
  return undefined;
}

/**
 * Find every attribute of a schema carrying a given semantic role.
 *
 * @param schema entity schema
 * @param role role to look for
 * @returns attribute names, in declaration order
 */
export function roleAttributes(
  schema: Schema | undefined,
  role: SchemaRole
): string[] {
  if (!schema) return [];
  return Object.entries(schema.attributes)
    .filter(([, attr]) => hasRole(attr, role))
    .map(([name]) => name);
}

/**
 * Refuse a payload naming an attribute the server owns.
 *
 * `generated` and `readOnly` say a value is not the client's to set. The flat
 * entities enforce it on their own paths; organizations and groups have their
 * own routes and need the same guard, or an endpoint promising that a computed
 * path "cannot be changed here" quietly accepts one.
 *
 * @param schema entity schema, when one is loaded
 * @param names attribute names carried by the request
 * @param mainAttribute RDN attribute, exempt when nothing derives it
 * @throws BadRequestError naming the first attribute the client may not set
 */
export function assertClientMaySet(
  schema: Schema | undefined,
  names: string[],
  mainAttribute?: string
): void {
  if (!schema) return;
  for (const name of names) {
    if (name === 'dn') continue;
    const attr = schema.attributes[name.split(';')[0]];
    if (!attr) continue;
    if (name === mainAttribute && !attr.generatedFrom) continue;
    if (!attr.generated && !attr.readOnly) continue;
    throw new BadRequestError(
      attr.readOnly
        ? `Attribute "${name}" is read-only and cannot be set`
        : `Attribute "${name}" is computed by the server and cannot be set`
    );
  }
}
