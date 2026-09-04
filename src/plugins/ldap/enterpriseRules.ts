/**
 * @module plugins/ldap/enterpriseRules
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Business rules an enterprise directory needs on top of declarative schema
 * validation: uniqueness across a shared namespace, mail addresses confined to
 * the domains an organization owns, computed organization paths, normalised
 * quotas, and referential-integrity guards on deletion.
 *
 * Nothing here knows a concrete attribute name, a domain, or a nomenclature
 * value. Every rule is driven by the loaded entity schemas — their semantic
 * `role`s and their per-attribute markers (`unique`, `mailDomainScope`,
 * `normalize`, `referentialIntegrity`, `deleteGuard`) — so the same code
 * serves a directory laid out differently without a line of change.
 *
 * ## Order of evaluation
 *
 * Checks run **before** transformations, and both run inside the same hook.
 * A check therefore always sees the payload as the client sent it: uniqueness
 * and domain rules validate the address that was submitted, never one the
 * server has already rewritten, and an identifier derived from that address
 * cannot influence the check that justified it.
 * @group Plugins
 */
import type { Request } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import type {
  Schema,
  SchemaAttribute,
  UniqueConstraint,
} from '../../config/schema';
import { hasRole, roleAttribute } from '../../config/schema';
import { escapeLdapFilter, getParentDn } from '../../lib/utils';
import { BadRequestError, ConflictError } from '../../lib/errors';

/** One entity the rules apply to: its branch and the schema describing it. */
interface EntityBinding {
  /** Branch the entries live in */
  base: string;
  /** True when entries sit anywhere under `base`, not only directly under it */
  subtree: boolean;
  schema: Schema;
  /** Name shown in error messages */
  label: string;
}

/** Attribute values, always as a list of strings. */
function valueList(value: AttributeValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(v => String(v));
  return [String(value)];
}

/**
 * Value of the first RDN of a DN, with its escapes removed.
 *
 * @param dn distinguished name
 * @returns the value, or an empty string when the DN has no RDN
 */
function rdnValue(dn: string): string {
  const match = /^[^=]+=((?:\\.|[^,])*)/.exec(dn);
  return match ? match[1].replace(/\\(.)/g, '$1') : '';
}

/** Byte multipliers, decimal as directories and mail servers count them. */
const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000000,
  GB: 1000000000,
  TB: 1000000000000,
};

/**
 * Read a human-readable size and return a number of bytes.
 *
 * `5GB`, `500 MB`, `2048` and `2048B` are all accepted; the multipliers are
 * decimal (1 GB = 10⁹ bytes), which is what mail servers report.
 *
 * @param raw value as submitted
 * @returns the size in bytes
 * @throws BadRequestError when the value is not a size
 */
export function parseByteSize(raw: AttributeValue): number {
  if (typeof raw === 'number') return Math.round(raw);
  const text = String(raw).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i.exec(text);
  if (!match) throw new BadRequestError(`"${text}" is not a valid size`);
  const unit = (match[2] || 'B').toUpperCase();
  return Math.round(parseFloat(match[1]) * SIZE_UNITS[unit]);
}

/**
 * Parse a directory date: an LDAP generalized time
 * (`yyyyMMddHHmmss[.SSS](Z|±HHMM)`) or anything `Date` understands.
 *
 * @param raw value as stored or submitted
 * @returns the date, or null when it cannot be read
 */
export function parseDirectoryDate(raw: AttributeValue): Date | null {
  const text = String(raw).trim();
  const generalized =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text
    );
  if (generalized) {
    const [, y, mo, d, h, mi, s, ms, zone] = generalized;
    const offset = !zone || zone === 'Z' ? 'Z' : zone;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${(ms || '0').padEnd(3, '0')}${offset}`;
    const parsed = new Date(iso);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Tell whether a mail address belongs to one of a set of domains.
 *
 * The host is taken after the *last* `@`, so the comparison cannot be fooled
 * by a prefix — the address format itself is the schema's business. A single
 * `*` among the domains authorises every domain.
 *
 * @param mail address to test
 * @param domains authorised domains; an empty list authorises everything
 * @param allowSubdomains accept `list@lists.example.org` under `example.org`
 * @returns true when the address is authorised
 */
export function mailInDomains(
  mail: string,
  domains: string[],
  allowSubdomains = false
): boolean {
  if (domains.length === 0) return true;
  if (domains.includes('*')) return true;
  const at = mail.lastIndexOf('@');
  if (at < 0) return false;
  const host = mail.slice(at + 1).toLowerCase();
  return domains.some(domain => {
    const d = domain.toLowerCase();
    return host === d || (allowSubdomains && host.endsWith(`.${d}`));
  });
}

export default class LdapEnterpriseRules extends DmPlugin {
  name = 'ldapEnterpriseRules';
  roles: Role[] = ['consistency'] as const;

  /** Attribute holding the mail domain of a domain entry */
  private domainNameAttribute: string;
  /** Placeholder member some directories keep to satisfy `groupOfNames` */
  private dummyMember?: string;
  /** Root of the organization tree */
  private topOrganization?: string;

  constructor(server: DM) {
    super(server);
    this.domainNameAttribute =
      this.config.enterprise_domain_name_attribute || 'associatedDomain';
    this.dummyMember = this.config.group_dummy_user;
    this.topOrganization = this.config.ldap_top_organization;
    this.logger.info('Enterprise directory rules enabled');
  }

  /**
   * Entities the rules apply to, rebuilt on each call.
   *
   * The organization and group plugins read their schema asynchronously, so a
   * snapshot taken in the constructor would miss them; the list is cheap to
   * rebuild since it only collects references.
   *
   * @returns one binding per entity whose schema is loaded
   */
  private bindings(): EntityBinding[] {
    const out: EntityBinding[] = [];

    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      | {
          instances?: { base: string; schema?: Schema; singularName: string }[];
        }
      | undefined;
    for (const instance of flat?.instances || []) {
      if (instance.schema)
        out.push({
          base: instance.base,
          subtree: false,
          schema: instance.schema,
          label: instance.singularName,
        });
    }

    const groups = this.server.loadedPlugins['ldapGroups'] as
      | { base?: string; schema?: Schema }
      | undefined;
    if (groups?.base && groups.schema)
      out.push({
        base: groups.base,
        subtree: true,
        schema: groups.schema,
        label: 'group',
      });

    const organizations = this.server.loadedPlugins['ldapOrganizations'] as
      | { schema?: Schema }
      | undefined;
    if (organizations?.schema && this.topOrganization)
      out.push({
        base: this.topOrganization,
        subtree: true,
        schema: organizations.schema,
        label: 'organization',
      });

    return out;
  }

  /**
   * Find the entity a DN belongs to: the binding with the longest matching
   * base, so a group branch nested inside the user branch still wins over it.
   *
   * @param dn entry being written
   * @returns the binding, or undefined when the DN belongs to no known entity
   */
  private resolveEntity(dn: string): EntityBinding | undefined {
    const target = dn.toLowerCase();
    let best: EntityBinding | undefined;
    for (const binding of this.bindings()) {
      const base = binding.base.toLowerCase();
      if (target === base) continue;
      if (!target.endsWith(`,${base}`)) continue;
      if (!binding.subtree && getParentDn(dn).toLowerCase() !== base) continue;
      if (!best || binding.base.length > best.base.length) best = binding;
    }
    return best;
  }

  hooks: Hooks = {
    ldapaddrequest: async ([dn, entry, req]) => {
      const entity = this.resolveEntity(dn);
      if (entity) {
        await this.runChecks(entity, dn, entry, null);
        await this.runTransformations(entity, dn, entry, true);
      }
      return req !== undefined
        ? [dn, entry, req]
        : ([dn, entry] as [string, AttributesList, Request?]);
    },

    ldapmodifyrequest: async ([dn, changes, op, req]) => {
      const entity = this.resolveEntity(dn);
      if (!entity) return [dn, changes, op, req];

      // A modify only carries what changes; rules that need the rest of the
      // entry — the organization a mail address is checked against, say — read
      // it from the directory.
      const submitted: AttributesList = {
        ...(changes.add || {}),
        ...(changes.replace || {}),
      };
      if (Object.keys(submitted).length === 0) return [dn, changes, op, req];

      const current = await this.readEntry(dn);
      await this.runChecks(entity, dn, submitted, current);
      await this.runTransformations(entity, dn, submitted, false);

      // Write the transformed values back where they came from.
      for (const [name, value] of Object.entries(submitted)) {
        if (changes.replace && name in changes.replace)
          changes.replace[name] = value;
        else if (changes.add && name in changes.add) changes.add[name] = value;
        else {
          changes.replace = changes.replace || {};
          changes.replace[name] = value;
        }
      }
      return [dn, changes, op, req];
    },

    ldapdeleterequest: async ([dn, req]: [string | string[], Request?]) => {
      for (const target of Array.isArray(dn) ? dn : [dn]) {
        await this.guardDelete(target);
      }
      return [dn, req] as [string | string[], Request?];
    },
  };

  /**
   * Validate a payload against the schema markers that need the directory:
   * uniqueness, mail domains and lifecycle dates.
   *
   * @param entity entity the entry belongs to
   * @param dn entry being written; excluded from uniqueness searches
   * @param values attributes as submitted
   * @param current entry as currently stored, on a modification
   */
  private async runChecks(
    entity: EntityBinding,
    dn: string,
    values: AttributesList,
    current: AttributesList | null
  ): Promise<void> {
    for (const [name, value] of Object.entries(values)) {
      const attr = entity.schema.attributes[name];
      if (!attr) continue;
      const list = valueList(value);
      if (list.length === 0) continue;

      if (attr.unique) {
        await this.checkUnique(entity, name, attr, list, current ? dn : null);
      }
      if (attr.mailDomainScope) {
        await this.checkMailDomains(entity, attr, list, values, current);
      }
      if (hasRole(attr, 'accountExpiry')) {
        this.checkNotInThePast(name, attr, list);
      }
    }
  }

  /**
   * Apply the value rewrites the server owns: normalisation, defaults for
   * attributes it fills itself, and the organization path derived from the
   * organization link.
   *
   * @param entity entity the entry belongs to
   * @param values attributes as submitted; mutated in place
   * @param creating true on a creation, where defaults apply
   */
  private async runTransformations(
    entity: EntityBinding,
    dn: string,
    values: AttributesList,
    creating: boolean
  ): Promise<void> {
    for (const [name, attr] of Object.entries(entity.schema.attributes)) {
      // A default the server owns: the initial account status, a quota floor.
      // It is applied only when the client said nothing, and only at creation
      // — and *before* the normalisation below, so that a default is held to
      // the same rules as a value the client sent. A schema is JSON, so a
      // default may be a number; a directory stores strings, and handing
      // ldapts a number throws from inside the encoder, well after the request
      // was accepted.
      if (
        creating &&
        values[name] === undefined &&
        attr.default !== undefined &&
        (attr.generated || attr.normalize)
      ) {
        values[name] = Array.isArray(attr.default)
          ? attr.default.map(v => String(v))
          : String(attr.default);
      }

      if (attr.normalize === 'byteSize' && values[name] !== undefined) {
        const list = valueList(values[name]);
        try {
          values[name] = Array.isArray(values[name])
            ? list.map(v => String(parseByteSize(v)))
            : String(parseByteSize(list[0]));
        } catch {
          throw new BadRequestError(
            `Invalid value for attribute "${name}"${attr.hint ? `: ${attr.hint}` : ''}`
          );
        }
      }
    }

    const pathAttr = roleAttribute(entity.schema, 'organizationPath');
    if (!pathAttr) return;

    const linkAttr = roleAttribute(entity.schema, 'organizationLink');
    if (linkAttr) {
      // An entry attached to an organization takes that organization's path.
      const link = valueList(values[linkAttr])[0];
      if (!link) return;
      const path = await this.organizationPath(link);
      if (path !== undefined) values[pathAttr] = path;
      return;
    }

    // An organization has no link: it *is* the tree, so its path is its
    // parent's plus its own name. A rename cascades to the descendants
    // through `core/ldap/departmentSync`, not from here.
    if (!creating) return;
    const name =
      valueList(values[roleAttribute(entity.schema, 'identifier') || ''])[0] ||
      rdnValue(dn);
    if (!name) return;
    const parentPath = await this.organizationPath(getParentDn(dn));
    const separator = this.config.ldap_organization_path_separator || ' / ';
    values[pathAttr] = parentPath ? `${parentPath}${separator}${name}` : name;
  }

  /**
   * Refuse a value already used elsewhere.
   *
   * Two things the rule this replaces got wrong are fixed here: values are
   * compared by content, and the entry being updated is excluded from the
   * search — so re-sending an unchanged name no longer conflicts with itself.
   *
   * @param entity entity the entry belongs to
   * @param name attribute being checked
   * @param attr its schema definition
   * @param values values submitted for it
   * @param selfDn DN to exclude, on a modification
   * @throws ConflictError naming the entry that already holds the value
   */
  private async checkUnique(
    entity: EntityBinding,
    name: string,
    attr: SchemaAttribute,
    values: string[],
    selfDn: string | null
  ): Promise<void> {
    const constraint: UniqueConstraint =
      typeof attr.unique === 'object' ? attr.unique : {};
    const attributes = [name, ...(constraint.attributes || [])];
    const bases = constraint.branches?.length
      ? constraint.branches
      : [entity.base];

    for (const value of values) {
      if (constraint.sentinel !== undefined && value === constraint.sentinel)
        continue;
      const terms = attributes
        .map(a => `(${a}=${escapeLdapFilter(value)})`)
        .join('');
      let filter = attributes.length > 1 ? `(|${terms})` : terms;
      if (constraint.filter) filter = `(&${constraint.filter}${filter})`;

      for (const base of bases) {
        const result = (await this.server.ldap.search(
          { paged: false, scope: 'sub', filter, attributes: ['dn'] },
          base
        )) as SearchResult;
        for (const found of result.searchEntries || []) {
          const foundDn = String(found.dn);
          if (selfDn && foundDn.toLowerCase() === selfDn.toLowerCase())
            continue;
          // The search above runs with the server's own visibility, on
          // purpose: the question is about the directory, not about what this
          // caller may read. Naming the holder back would answer a question
          // the caller was never allowed to ask — a manager scoped to one
          // branch could probe any address and be told which entry, in which
          // branch, already holds it. The operator gets the DN in the log.
          this.logger.warn(
            `${name}="${value}" refused for ${selfDn || 'a new entry'}: already held by ${foundDn}`
          );
          throw new ConflictError(
            `${entity.label}: "${value}" is already used (${name} must be unique)`
          );
        }
      }
    }
  }

  /**
   * Refuse a mail address outside the domains its organization may use.
   *
   * @param entity entity the entry belongs to
   * @param attr schema definition of the mail attribute
   * @param values addresses submitted
   * @param submitted attributes as submitted, read for the organization link
   * @param current entry as stored, when the link is not being changed
   * @throws BadRequestError when no organization can be resolved
   * @throws ConflictError when the address is outside the authorised domains
   */
  private async checkMailDomains(
    entity: EntityBinding,
    attr: SchemaAttribute,
    values: string[],
    submitted: AttributesList,
    current: AttributesList | null
  ): Promise<void> {
    const domains =
      attr.mailDomainScope === 'directory'
        ? await this.directoryDomains()
        : await this.organizationDomains(entity, submitted, current);
    if (domains.length === 0) return;

    for (const value of values) {
      if (!mailInDomains(value, domains, attr.allowSubdomains)) {
        throw new ConflictError(
          `The mail domain of "${value}" is not one of the authorised domains (${domains.join(', ')})`
        );
      }
    }
  }

  /**
   * Domains an entry may use, walking up from its organization to the root of
   * the tree and collecting what each level declares. An organization that
   * declares none inherits whatever its ancestors allow; when nobody declares
   * anything, no restriction applies.
   *
   * @param entity entity the entry belongs to
   * @param submitted attributes as submitted
   * @param current entry as stored, when the link is not being changed
   * @returns the authorised domain names
   */
  private async organizationDomains(
    entity: EntityBinding,
    submitted: AttributesList,
    current: AttributesList | null
  ): Promise<string[]> {
    const linkAttr = roleAttribute(entity.schema, 'organizationLink');
    if (!linkAttr) return [];
    const link =
      valueList(submitted[linkAttr])[0] ||
      valueList(current?.[linkAttr])[0] ||
      undefined;
    if (!link) return [];

    const orgSchema = this.bindings().find(
      b => b.label === 'organization'
    )?.schema;
    const domainLinkAttr =
      roleAttribute(orgSchema, 'domainLink') ||
      this.config.enterprise_domain_link_attribute;
    if (!domainLinkAttr) return [];

    const domains: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = link;
    const stop = (
      this.topOrganization ||
      this.config.ldap_base ||
      ''
    ).toLowerCase();

    while (cursor && !seen.has(cursor.toLowerCase())) {
      seen.add(cursor.toLowerCase());
      const org = await this.readEntry(cursor);
      for (const domainDn of valueList(org?.[domainLinkAttr])) {
        const domain = await this.readEntry(domainDn);
        domains.push(...valueList(domain?.[this.domainNameAttribute]));
      }
      if (cursor.toLowerCase() === stop) break;
      const parent = getParentDn(cursor);
      cursor = parent === cursor ? undefined : parent;
    }
    return domains;
  }

  /** Every mail domain declared anywhere in the directory. */
  private async directoryDomains(): Promise<string[]> {
    const base = this.config.ldap_base;
    if (!base) return [];
    const result = (await this.server.ldap.search(
      {
        paged: false,
        scope: 'sub',
        filter: `(${this.domainNameAttribute}=*)`,
        attributes: [this.domainNameAttribute],
      },
      base
    )) as SearchResult;
    const domains: string[] = [];
    for (const entry of result.searchEntries || [])
      domains.push(
        ...valueList(entry[this.domainNameAttribute] as AttributeValue)
      );
    return domains;
  }

  /**
   * Refuse a lifecycle date that has already passed. The comparison is against
   * the start of the current day, so scheduling something for today is
   * allowed — which is what "not earlier than today" means to the person
   * filling the form.
   *
   * @param name attribute being checked
   * @param attr its schema definition
   * @param values dates submitted
   * @throws BadRequestError when a date is unreadable or in the past
   */
  private checkNotInThePast(
    name: string,
    attr: SchemaAttribute,
    values: string[]
  ): void {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    for (const value of values) {
      const date = parseDirectoryDate(value);
      if (!date) {
        throw new BadRequestError(
          `Invalid value for attribute "${name}"${attr.hint ? `: ${attr.hint}` : ''}`
        );
      }
      if (date.getTime() < startOfToday.getTime()) {
        throw new BadRequestError(
          `Attribute "${name}" must not be earlier than today`
        );
      }
    }
  }

  /**
   * Read the human-readable path of an organization.
   *
   * @param orgDn DN of the organization
   * @returns the path, or undefined when the organization carries none
   */
  private async organizationPath(orgDn: string): Promise<string | undefined> {
    const orgSchema = this.bindings().find(
      b => b.label === 'organization'
    )?.schema;
    const pathAttr =
      roleAttribute(orgSchema, 'organizationPath') ||
      this.config.ldap_organization_path_attribute;
    if (!pathAttr) return undefined;
    const org = await this.readEntry(orgDn);
    if (!org) return undefined;
    return valueList(org[pathAttr])[0];
  }

  /**
   * Refuse a deletion that would leave the directory inconsistent: an entry
   * other entries still point at, or a group that still has members.
   *
   * @param dn entry about to be deleted
   * @throws ConflictError naming what still depends on the entry
   */
  private async guardDelete(dn: string): Promise<void> {
    const entity = this.resolveEntity(dn);
    if (entity) {
      for (const [name, attr] of Object.entries(entity.schema.attributes)) {
        if (attr.deleteGuard !== 'nonEmpty') continue;
        const entry = await this.readEntry(dn);
        const members = valueList(entry?.[name]).filter(
          member =>
            !this.dummyMember ||
            member.toLowerCase() !== this.dummyMember.toLowerCase()
        );
        if (members.length > 0) {
          throw new ConflictError(
            `Cannot delete ${entity.label} ${dn}: it still has ${members.length} member(s)`
          );
        }
      }
    }
    await this.guardReferences(dn);
  }

  /**
   * Refuse to delete an entry that a `referentialIntegrity: restrict` pointer
   * still names. The pointers are read from the schemas themselves, so a new
   * reference is protected by declaring it, not by editing this file.
   *
   * @param dn entry about to be deleted
   * @throws ConflictError naming the first referencing entry
   */
  private async guardReferences(dn: string): Promise<void> {
    const parent = getParentDn(dn).toLowerCase();
    for (const binding of this.bindings()) {
      for (const [name, attr] of Object.entries(binding.schema.attributes)) {
        const pointer = attr.type === 'pointer' ? attr : attr.items;
        if (!pointer) continue;
        if (attr.referentialIntegrity !== 'restrict') continue;
        // Only search when the deleted entry could be a legal target.
        const branches = (pointer.branch || []).map(b => b.toLowerCase());
        if (
          branches.length > 0 &&
          !branches.some(b => parent === b || parent.endsWith(`,${b}`))
        )
          continue;

        const result = (await this.server.ldap.search(
          {
            paged: false,
            scope: 'sub',
            filter: `(${name}=${escapeLdapFilter(dn)})`,
            attributes: ['dn'],
          },
          binding.base
        )) as SearchResult;
        const referrer = (result.searchEntries || [])[0];
        if (referrer) {
          // Same reasoning as checkUnique: the caller owns the DN being
          // deleted, not the one pointing at it.
          this.logger.warn(
            `Delete of ${dn} refused: still referenced by ${String(referrer.dn)} (${name})`
          );
          throw new ConflictError(
            `Cannot delete ${dn}: still referenced by another entry (${name})`
          );
        }
      }
    }
  }

  /**
   * Read a single entry, without a request so the lookup is not narrowed by
   * the caller's own permissions: these rules answer about the directory as a
   * whole, not about what one manager may see.
   *
   * @param dn entry to read
   * @returns the entry, or null when it does not exist
   */
  private async readEntry(dn: string): Promise<AttributesList | null> {
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
      return (result?.searchEntries?.[0] as AttributesList) || null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      return null;
    }
  }
}
