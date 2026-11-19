/**
 * @module plugins/scim/groups
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM Groups resource handler — direct access via ldapActions.
 */
import type winston from 'winston';

import type ldapActions from '../../lib/ldapActions.js';
import type {
  AttributesList,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions.js';
import type { Config } from '../../config/args.js';
import type { DmRequest } from '../../lib/auth/base.js';
import type HookBus from '../../lib/hookBus.js';
import { isAuthzRefusal } from '../../lib/errors.js';
import {
  escapeDnValue,
  escapeLdapFilter,
  isChildOf,
  isDummyMemberDn,
  normalizeDn,
  parseDn,
  rdnValue,
  validateDnValue,
} from '../../lib/utils.js';

import { BaseResolver } from './baseResolver.js';
import {
  type ResourceMapping,
  type ScimGroup,
  type ListResponse,
  type PatchRequest,
  type MultiValued,
  SCHEMA_LIST_RESPONSE,
} from './types.js';
import {
  DEFAULT_GROUP_MAPPING,
  loadMappingFile,
  mergeMapping,
  withExternalId,
  ldapToScimGroup,
  scimGroupToLdap,
  requiredLdapAttributes,
  asArray,
  asString,
  type MappingContext,
} from './mapping.js';
import { scimFilterToLdap } from './filter.js';
import { pagedSearch } from './list.js';
import { projectionKeeps, type ProjectionQuery } from './projection.js';
import { patchToModifyRequest, writePatch } from './patch.js';
import {
  extractLdapCode,
  kindOf,
  ScimError,
  scimInvalidValue,
  scimNotFound,
  scimUniqueness,
} from './errors.js';
import type { ScimUsers } from './users.js';
import type { ScimOptions } from './scim.options.js';

/** Member entries read at once when their ids are not their RDN values */
const MEMBER_READS = 8;

/** A projection for a read that only checks the group is there */
const ONLY_ID: ProjectionQuery = { attributes: ['id'] };

/**
 * Whether a member read failed because the entry is not there for the caller:
 * absent (LDAP 32), or refused (LDAP 50, or an authorization plugin).
 */
const isUnreadableMember = (err: unknown): boolean => {
  const code = extractLdapCode(err);
  return code === 32 || code === 50 || isAuthzRefusal(err);
};

export interface GroupListQuery {
  filter?: string;
  startIndex?: number;
  count?: number;
  // sortBy / sortOrder accepted for parser compatibility but not honoured
  // (ServiceProviderConfig advertises sort.supported = false).
  sortBy?: string;
  sortOrder?: 'ascending' | 'descending';
}

export interface ScimGroupsOptions {
  ldap: ldapActions;
  config: Config;
  options: ScimOptions;
  logger: winston.Logger;
  baseResolver: BaseResolver;
  users: ScimUsers;
  hookBus: HookBus;
}

export class ScimGroups {
  private readonly ldap: ldapActions;
  private readonly config: Config;
  private readonly options: ScimOptions;
  private readonly logger: winston.Logger;
  private readonly baseResolver: BaseResolver;
  private readonly users: ScimUsers;
  private readonly hookBus: HookBus;
  private readonly mapping: ResourceMapping;
  private readonly attributes: string[];
  /** What a PATCH reads: write-only attributes too, to remove them */
  private readonly patchAttributes: string[];
  private readonly rdnAttribute: string;
  private readonly objectClass: string[];
  private readonly idAttribute: string;
  private readonly maxResults: number;
  private readonly maxScanned: number;
  private readonly scimPrefix: string;

  constructor(opts: ScimGroupsOptions) {
    this.ldap = opts.ldap;
    this.config = opts.config;
    this.options = opts.options;
    this.logger = opts.logger;
    this.baseResolver = opts.baseResolver;
    this.users = opts.users;
    this.hookBus = opts.hookBus;

    this.rdnAttribute = this.options.scim_group_rdn_attribute;
    this.objectClass = this.options.scim_group_object_class;
    this.idAttribute = this.options.scim_id_attribute;
    this.maxResults = this.options.scim_max_results;
    this.maxScanned = this.options.scim_max_scanned;
    this.scimPrefix = this.options.scim_prefix;

    const override = this.options.scim_group_mapping;
    this.mapping = withExternalId(
      mergeMapping(
        DEFAULT_GROUP_MAPPING,
        override ? loadMappingFile(override) : undefined
      ),
      this.options.scim_group_external_id_attribute
    );
    this.attributes = requiredLdapAttributes(this.mapping, [
      this.rdnAttribute,
      'member',
    ]);
    this.patchAttributes = requiredLdapAttributes(
      this.mapping,
      [this.rdnAttribute, 'member'],
      true
    );
  }

  private ctx(req?: DmRequest): MappingContext {
    return {
      idAttribute: this.idAttribute,
      rdnAttribute: this.rdnAttribute,
      resourceType: 'Group',
      baseUrl:
        this.options.scim_base_url ||
        (req?.protocol && req.get
          ? `${req.protocol}://${String(req.get('host') || '')}`
          : ''),
      scimPrefix: this.scimPrefix,
      // RFC 7643 section 4.2 gives Groups no `active`, so there is no lock
      // attribute to name. Empty rather than the User default: an entry
      // never holds an attribute called '', so `isLocked` reads false and
      // nothing can be written under it by accident.
      lockAttribute: '',
      lockValue: '',
    };
  }

  /** Whether a SCIM id is the RDN value, so its DN is built, not searched */
  private get idIsRdn(): boolean {
    return (
      this.idAttribute === 'rdn' ||
      this.idAttribute.toLowerCase() === this.rdnAttribute.toLowerCase()
    );
  }

  /** DN of the entry a SCIM id names, see ScimUsers.dnForId */
  private async dnForId(id: string, req: DmRequest): Promise<string> {
    if (this.idIsRdn)
      return `${this.rdnAttribute}=${escapeDnValue(id)},${this.baseResolver.groupBase(req)}`;
    const dn = await this.findById(req, id);
    if (!dn) throw scimNotFound(`Group ${id} not found`);
    return dn;
  }

  /**
   * The group under the group base whose id attribute holds `id`, when ids
   * are not RDN values.
   *
   * @param req the request, for the tenant's base and the caller's rights
   * @param id a SCIM id
   * @returns its DN, undefined unless exactly one group holds it
   */
  private async findById(
    req: DmRequest,
    id: string
  ): Promise<string | undefined> {
    let result: SearchResult;
    try {
      result = (await this.ldap.forRequest(req).search(
        {
          filter: `(${this.idAttribute}=${escapeLdapFilter(id)})`,
          scope: 'sub',
          paged: false,
          attributes: ['dn'],
        },
        this.baseResolver.groupBase(req)
      )) as SearchResult;
    } catch (err) {
      // The base itself is absent: no match, same as an empty result
      if (extractLdapCode(err) === 32) return undefined;
      throw err;
    }
    return result.searchEntries?.length === 1
      ? result.searchEntries[0].dn
      : undefined;
  }

  /**
   * The SCIM id of each member DN of `entries`, keyed by lower-cased DN, when
   * the id is not the RDN value: one base read per distinct member, a few at
   * a time. A member that is absent, that the caller may not read, or that
   * lacks the id attribute, is left out and answered by its RDN value; any
   * other failure is raised.
   */
  private async memberIds(
    req: DmRequest,
    entries: AttributesList[]
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (this.idIsRdn) return ids;
    const placeholder = this.config.group_dummy_user || 'cn=fakeuser';
    const dns = new Map<string, string>();
    for (const e of entries)
      for (const dn of asArray(e['member']))
        if (dn && !isDummyMemberDn(dn, placeholder))
          dns.set(dn.toLowerCase(), dn);
    const directory = this.ldap.forRequest(req);
    const queue = [...dns.entries()];
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, dn] = next;
        try {
          const result = (await directory.search(
            {
              scope: 'base',
              paged: false,
              attributes: [this.idAttribute],
            },
            dn
          )) as SearchResult;
          const entry = result.searchEntries?.[0];
          const id = entry ? asString(entry[this.idAttribute]) : undefined;
          if (id) ids.set(key, id);
        } catch (err) {
          if (!isUnreadableMember(err)) throw err;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MEMBER_READS, queue.length) }, worker)
    );
    return ids;
  }

  /**
   * Resolve an LDAP member DN back to a SCIM reference (for GET responses):
   * its id from `ids` (see memberIds), else its RDN value, and a type guessed
   * from its base or RDN attribute.
   */
  private buildMemberResolver(
    req: DmRequest | undefined,
    ids: Map<string, string> = new Map()
  ): (dn: string) => MultiValued | undefined {
    const userBase = this.baseResolver.userBase(req);
    const groupBase = this.baseResolver.groupBase(req);
    const scimPrefix = this.scimPrefix;
    const baseUrl =
      this.options.scim_base_url ||
      (req?.protocol && req.get
        ? `${req.protocol}://${String(req.get('host') || '')}`
        : '');
    const userRdn = this.options.scim_user_rdn_attribute;
    const groupRdn = this.rdnAttribute;

    const placeholder = this.config.group_dummy_user || 'cn=fakeuser';
    return (dn: string): MultiValued | undefined => {
      if (!dn) return undefined;
      // Hide the schema-placeholder member from SCIM responses. Compared as
      // a DN: the directory's own spelling of the configured placeholder is
      // still the placeholder.
      if (isDummyMemberDn(dn, placeholder)) return undefined;
      const [rdn] = parseDn(dn);
      const eq = rdn ? rdn.indexOf('=') : -1;
      if (eq <= 0) return undefined;
      const rdnType = rdn.slice(0, eq).trim();
      const value = ids.get(dn.toLowerCase()) ?? rdnValue(dn);
      const lower = dn.toLowerCase();
      let type: 'User' | 'Group' | undefined;
      if (userBase && lower.endsWith(userBase.toLowerCase())) type = 'User';
      else if (groupBase && lower.endsWith(groupBase.toLowerCase()))
        type = 'Group';
      else if (rdnType === userRdn) type = 'User';
      else if (rdnType === groupRdn) type = 'Group';
      const result: MultiValued = { value };
      if (type) {
        result.type = type;
        if (baseUrl) {
          const endpoint = type === 'User' ? 'Users' : 'Groups';
          result.$ref = `${baseUrl.replace(/\/$/, '')}${scimPrefix}/${endpoint}/${encodeURIComponent(value)}`;
        }
      }
      return result;
    };
  }

  /**
   * The DNs a group body's members name, in the order given.
   *
   * A value that names no entry the caller can see is left out, as one that
   * does not exist is: raising would make a client resending what it read
   * fail on a member another writer removed meanwhile.
   *
   * @param req the request, for the tenant's bases and the caller's rights
   * @param members the members as the client sent them
   * @returns their DNs, without the ones that resolved to nothing
   */
  private async resolveMembers(
    req: DmRequest,
    members: MultiValued[]
  ): Promise<string[]> {
    const dns: string[] = [];
    for (const m of members) {
      if (!m || m.value == null) continue;
      if (typeof m.value !== 'string')
        throw scimInvalidValue(
          `Each member value must be a string, got ${kindOf(m.value)}`
        );
      const dn = await this.resolveMember(req, m.value, m);
      if (dn) dns.push(dn);
    }
    return dns;
  }

  /**
   * The DN a member value names, as the kind of resource the member says.
   *
   * A user and a group can carry the same id — `--scim-id-attribute`
   * defaults to the RDN value — so the kind decides which base is searched,
   * and a reference that does not say is looked up as a user first, then as
   * a group. A bare value names a group only at its own DN, where its id
   * says it is: a deleted user's id must not become a group of that name
   * elsewhere under the branch.
   *
   * @param req the request, for the tenant's bases and the caller's rights
   * @param value the member's `value`, an id or a DN
   * @param ref what the member said about the entry it names
   * @returns its DN, undefined when no entry matches
   */
  private async resolveMember(
    req: DmRequest,
    value: string,
    ref?: Pick<MultiValued, 'type' | '$ref'>
  ): Promise<string | undefined> {
    switch (memberKind(ref)) {
      case 'User':
        return this.users.resolveRef(req, value);
      case 'Group':
        return this.resolveRef(req, value);
      default: {
        const user = await this.users.resolveRef(req, value);
        if (user) return user;
        return this.resolveAt(req, value);
      }
    }
  }

  /**
   * The group a SCIM id names.
   *
   * @param req the request, for the tenant's base and the caller's rights
   * @param id its SCIM id
   * @param projection what the answer keeps: without `members`, their ids
   *   are not read
   * @returns the group
   */
  async get(
    req: DmRequest,
    id: string,
    projection: ProjectionQuery = {}
  ): Promise<ScimGroup> {
    return this.getByDn(req, await this.dnForId(id, req), id, projection);
  }

  private async getByDn(
    req: DmRequest,
    dn: string,
    id: string,
    projection: ProjectionQuery = {}
  ): Promise<ScimGroup> {
    let result: SearchResult;
    try {
      result = (await this.ldap.forRequest(req).search(
        {
          paged: false,
          scope: 'base',
          attributes: this.attributes,
        },
        dn
      )) as SearchResult;
    } catch (err) {
      if (extractLdapCode(err) === 32) {
        throw scimNotFound(`Group ${id} not found`);
      }
      throw err;
    }
    if (!result.searchEntries || result.searchEntries.length === 0) {
      throw scimNotFound(`Group ${id} not found`);
    }
    const entry = result.searchEntries[0];
    return ldapToScimGroup(
      entry,
      this.mapping,
      this.ctx(req),
      this.buildMemberResolver(
        req,
        projectionKeeps(projection, 'members')
          ? await this.memberIds(req, [entry])
          : undefined
      )
    );
  }

  async list(
    req: DmRequest,
    query: GroupListQuery & ProjectionQuery
  ): Promise<ListResponse<ScimGroup>> {
    const base = this.baseResolver.groupBase(req);
    const startIndex = Math.max(1, query.startIndex || 1);
    const count = Math.min(
      this.maxResults,
      Math.max(0, query.count ?? this.maxResults)
    );

    let ldapFilter = `(objectClass=${this.objectClass.find(c => c !== 'top') || 'groupOfNames'})`;
    let idEquals: string | undefined;
    if (query.filter) {
      const translated = scimFilterToLdap(query.filter, this.mapping);
      if (translated.idEquals) {
        idEquals = translated.idEquals;
      } else {
        ldapFilter = `(&${ldapFilter}${translated.ldapFilter})`;
      }
    }

    if (idEquals) {
      try {
        const group = await this.get(req, idEquals, query);
        return {
          schemas: [SCHEMA_LIST_RESPONSE],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
          Resources: [group],
        };
      } catch (err) {
        if (err instanceof ScimError && err.statusCode === 404) {
          return {
            schemas: [SCHEMA_LIST_RESPONSE],
            totalResults: 0,
            startIndex: 1,
            itemsPerPage: 0,
            Resources: [],
          };
        }
        throw err;
      }
    }

    const { entries, totalResults } = await pagedSearch({
      directory: this.ldap.forRequest(req),
      base,
      filter: ldapFilter,
      attributes: this.attributes,
      startIndex,
      count,
      maxScanned: this.maxScanned,
    });

    const resolver = this.buildMemberResolver(
      req,
      projectionKeeps(query, 'members')
        ? await this.memberIds(req, entries)
        : undefined
    );
    const resources = entries.map(e =>
      ldapToScimGroup(e, this.mapping, this.ctx(req), resolver)
    );
    return {
      schemas: [SCHEMA_LIST_RESPONSE],
      totalResults,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  async create(req: DmRequest, resource: ScimGroup): Promise<ScimGroup> {
    if (!resource.displayName) {
      throw scimInvalidValue('displayName is required');
    }
    const base = this.baseResolver.groupBase(req);
    // RFC 7643 section 3.1: the client never chooses `id`. A
    // `scimgroupcreate` hook may assign one to name the entry, unless the
    // mapping already fills the RDN attribute, which the id would overwrite.
    // The hooks read the body as a Group: refuse a malformed one before they do
    scimGroupToLdap(
      { ...resource, id: undefined },
      this.mapping,
      this.objectClass
    );
    const [group] = await this.hookBus.chain('scimgroupcreate', [
      { ...resource, id: undefined },
      req,
      base,
    ]);

    const { rdn: named, attributes } = scimGroupToLdap(
      group,
      this.mapping,
      this.objectClass
    );
    const rdn = (!attributes[this.rdnAttribute] && group.id) || named;
    if (!rdn) throw scimInvalidValue('displayName is required');
    validateDnValue(rdn, this.rdnAttribute);
    attributes[this.rdnAttribute] = rdn;

    // Resolve members (SCIM value → LDAP DN)
    const memberDns =
      group.members && Array.isArray(group.members)
        ? await this.resolveMembers(req, group.members)
        : [];
    // groupOfNames requires at least one member
    if (memberDns.length === 0) {
      // Fall back to a placeholder; mirrors --group-dummy-user convention
      const placeholder = this.config.group_dummy_user || 'cn=fakeuser';
      memberDns.push(placeholder);
    }
    attributes.member = memberDns;

    const dn = `${this.rdnAttribute}=${escapeDnValue(rdn)},${base}`;

    try {
      await this.ldap.forRequest(req).add(dn, attributes);
    } catch (err) {
      if (extractLdapCode(err) === 68) {
        throw scimUniqueness(`Group ${rdn} already exists`);
      }
      throw err;
    }

    const created = await this.getByDn(req, dn, rdn);
    this.hookBus.notify('scimgroupcreatedone', created);
    return created;
  }

  async replace(
    req: DmRequest,
    id: string,
    resource: ScimGroup
  ): Promise<ScimGroup> {
    await this.get(req, id, ONLY_ID); // ensure exists
    const hookInput = await this.hookBus.chain('scimgroupupdate', [
      id,
      resource,
      req,
    ]);
    const incoming = hookInput[1];

    const { attributes } = scimGroupToLdap(
      incoming,
      this.mapping,
      this.objectClass
    );

    const memberDns =
      incoming.members && Array.isArray(incoming.members)
        ? await this.resolveMembers(req, incoming.members)
        : [];
    if (memberDns.length === 0) {
      const placeholder = this.config.group_dummy_user || 'cn=fakeuser';
      memberDns.push(placeholder);
    }

    const dn = await this.dnForId(id, req);
    this.assertNotSelfMember(dn, memberDns);
    const changes: ModifyRequest = { replace: {} };
    for (const [k, v] of Object.entries(attributes)) {
      if (k === 'objectClass' || k === this.rdnAttribute) continue;
      changes.replace![k] = v;
    }
    changes.replace!.member = memberDns;
    await this.ldap.forRequest(req).modify(dn, changes);

    const updated = await this.get(req, id);
    this.hookBus.notify('scimgroupupdatedone', id, updated);
    return updated;
  }

  async patch(
    req: DmRequest,
    id: string,
    patch: PatchRequest
  ): Promise<ScimGroup> {
    const dn = await this.dnForId(id, req);
    await writePatch(dn, async () => {
      const current = await this.currentEntry(req, dn, id); // ensure exists
      const changes = await patchToModifyRequest(patch, {
        mapping: this.mapping,
        memberAttribute: 'member',
        resolveMemberRef: (value, ref) => this.resolveMember(req, value, ref),
        current,
      });

      // The group cannot hold itself; dropping a self-member the directory
      // already holds stays possible, so only what is added or set is read.
      this.assertNotSelfMember(
        dn,
        [changes.add?.member, changes.replace?.member]
          .flatMap(v => (v == null ? [] : ([] as unknown[]).concat(v)))
          .map(String)
      );

      // groupOfNames requires at least one member, so a patch that empties the
      // attribute gets the configured placeholder instead of a schema
      // violation. A bare remove deletes the attribute: replace it. A removal
      // of named members leaves any the read did not show; the placeholder
      // only joins when none the caller saw remain.
      const removed =
        changes.delete && !Array.isArray(changes.delete)
          ? changes.delete.member
          : undefined;
      if (removed !== undefined) {
        const placeholder = this.config.group_dummy_user || 'cn=fakeuser';
        if (removed === '') {
          delete (changes.delete as Record<string, unknown>).member;
          if (Object.keys(changes.delete!).length === 0) delete changes.delete;
          if (!changes.replace) changes.replace = {};
          changes.replace.member = [placeholder];
        } else {
          const gone = ([] as string[]).concat(removed as string | string[]);
          const left = ([] as unknown[])
            .concat(current.member ?? [], changes.add?.member ?? [])
            .map(String)
            .filter(m => !gone.includes(m));
          if (left.length === 0) {
            if (!changes.add) changes.add = {};
            changes.add.member = placeholder;
          }
        }
      }

      // An empty change set still goes through ldapActions: `ldapmodifyrequest`
      // is where write permission is checked, and an empty modify touches the
      // directory not at all. Permissive: re-adding a member the read did not
      // show is no error.
      await this.ldap.forRequest(req).modify(dn, changes, { permissive: true });
    });
    const updated = await this.get(req, id);
    this.hookBus.notify('scimgroupupdatedone', id, updated);
    return updated;
  }

  /** Fetch the raw LDAP entry backing a SCIM id, or raise 404. */
  private async currentEntry(
    req: DmRequest,
    dn: string,
    id: string
  ): Promise<AttributesList> {
    let result: SearchResult;
    try {
      result = (await this.ldap.forRequest(req).search(
        {
          paged: false,
          scope: 'base',
          attributes: this.patchAttributes,
        },
        dn
      )) as SearchResult;
    } catch (err) {
      if (extractLdapCode(err) === 32) {
        throw scimNotFound(`Group ${id} not found`);
      }
      throw err;
    }
    if (!result.searchEntries?.length) {
      throw scimNotFound(`Group ${id} not found`);
    }
    return result.searchEntries[0];
  }

  async delete(req: DmRequest, id: string): Promise<void> {
    await this.get(req, id, ONLY_ID); // ensure exists
    const [finalId] = await this.hookBus.chain('scimgroupdelete', [id, req]);
    const dn = await this.dnForId(finalId, req);
    await this.ldap.forRequest(req).delete(dn);
    this.hookBus.notify('scimgroupdeletedone', finalId);
  }

  /**
   * Refuse a write that would make the group a member of itself: every
   * consumer expanding memberships would loop.
   *
   * Only what a write adds or sets is checked, so a group the directory
   * already holds as its own member can still drop it.
   *
   * @param dn the group being written
   * @param written the member DNs the write adds or sets
   * @throws Error when one of them is the group itself
   */
  private assertNotSelfMember(dn: string, written: readonly string[]): void {
    if (written.some(m => sameDn(m, dn)))
      throw scimInvalidValue('A group cannot be a member of itself');
  }

  /**
   * The group at the DN a value names, under the group base and nowhere
   * else: a bare value names `cn=<value>,<group base>`, or, when ids are not
   * RDN values, the one group whose id attribute holds it.
   *
   * @param req the request, for the tenant's base and the caller's rights
   * @param value an id or a DN
   * @returns its DN, undefined when nothing is there
   */
  private async resolveAt(
    req: DmRequest,
    value: string
  ): Promise<string | undefined> {
    if (!value) return undefined;
    const base = this.baseResolver.groupBase(req);
    const given = value.includes('=') && value.includes(',');
    if (given && !isChildOf(value, base)) return undefined;
    const dn = given
      ? value
      : `${this.rdnAttribute}=${escapeDnValue(value)},${base}`;
    try {
      const res = (await this.ldap
        .forRequest(req)
        .search(
          { paged: false, scope: 'base', attributes: ['dn'] },
          dn
        )) as SearchResult;
      if (res.searchEntries && res.searchEntries.length > 0)
        return res.searchEntries[0].dn;
    } catch (err) {
      // Only "no such object" is a miss. Anything else — an authorization
      // refusal, a broken connection — must not be read as an absent member,
      // which would silently drop the reference from the group.
      if (extractLdapCode(err) !== 32) throw err;
    }
    if (given || this.idIsRdn) return undefined;
    return this.findById(req, value);
  }

  /** Used internally and by Bulk to resolve a Group SCIM reference to a DN. */
  async resolveRef(req: DmRequest, value: string): Promise<string | undefined> {
    const found = await this.resolveAt(req, value);
    if (found || !value) return found;
    // A DN names one entry: no filter finds it elsewhere
    if (value.includes('=') && value.includes(',')) return undefined;
    const base = this.baseResolver.groupBase(req);
    try {
      const res = (await this.ldap.forRequest(req).search(
        {
          filter: `(${this.rdnAttribute}=${escapeLdapFilter(value)})`,
          scope: 'sub',
          paged: false,
          attributes: ['dn'],
        },
        base
      )) as SearchResult;
      if (res.searchEntries && res.searchEntries.length > 0) {
        return res.searchEntries[0].dn;
      }
    } catch (err) {
      if (extractLdapCode(err) !== 32) throw err;
      // The base itself is absent: no match, same as an empty result.
    }
    return undefined;
  }

  get groupMapping(): ResourceMapping {
    return this.mapping;
  }
}

/**
 * The kind of entry a member reference names, when it says: its `type`, or
 * else the endpoint its `$ref` points at. `type` is the normative attribute
 * (RFC 7643 section 4.2) and wins when the two disagree.
 *
 * @param ref what the member sent besides its value
 * @returns the kind, undefined when the reference does not say
 */
function memberKind(ref?: {
  type?: unknown;
  $ref?: unknown;
}): 'User' | 'Group' | undefined {
  const named =
    typeof ref?.type === 'string' ? ref.type.trim().toLowerCase() : '';
  if (named === 'user' || named === 'group')
    return named === 'user' ? 'User' : 'Group';
  const endpoint =
    typeof ref?.$ref === 'string'
      ? /\/(users|groups)\/[^/?#]+\/?$/i.exec(ref.$ref.split(/[?#]/)[0])?.[1]
      : undefined;
  if (endpoint?.toLowerCase() === 'users') return 'User';
  if (endpoint?.toLowerCase() === 'groups') return 'Group';
  return undefined;
}

/**
 * Whether two DNs name the same entry, however each is spelled.
 *
 * @param a a DN
 * @param b another DN
 * @returns true when the directory reads them as one
 */
function sameDn(a: string, b: string): boolean {
  try {
    return normalizeDn(a) === normalizeDn(b);
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}
