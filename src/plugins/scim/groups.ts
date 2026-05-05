/**
 * @module plugins/scim/groups
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM Groups resource handler — direct access via ldapActions.
 */
import type winston from 'winston';

import type ldapActions from '../../lib/ldapActions';
import type {
  AttributesList,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import type { Config } from '../../config/args';
import type { DmRequest } from '../../lib/auth/base';
import {
  escapeDnValue,
  escapeLdapFilter,
  isChildOf,
  launchHooks,
  launchHooksChained,
  validateDnValue,
} from '../../lib/utils';

import { BaseResolver } from './baseResolver';
import {
  type ResourceMapping,
  type ScimGroup,
  type ListResponse,
  type PatchRequest,
  type MultiValued,
  SCHEMA_LIST_RESPONSE,
} from './types';
import {
  DEFAULT_GROUP_MAPPING,
  loadMappingFile,
  mergeMapping,
  ldapToScimGroup,
  scimGroupToLdap,
  requiredLdapAttributes,
  type MappingContext,
} from './mapping';
import { scimFilterToLdap } from './filter';
import { patchToModifyRequest } from './patch';
import {
  scimInvalidValue,
  scimNotFound,
  scimTooMany,
  scimUniqueness,
  ScimError,
  extractLdapCode,
} from './errors';
import type { ScimUsers } from './users';

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
  logger: winston.Logger;
  baseResolver: BaseResolver;
  users: ScimUsers;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  hooks: { [K: string]: Function[] | undefined };
}

export class ScimGroups {
  private readonly ldap: ldapActions;
  private readonly config: Config;
  private readonly logger: winston.Logger;
  private readonly baseResolver: BaseResolver;
  private readonly users: ScimUsers;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private readonly hooks: { [K: string]: Function[] | undefined };
  private readonly mapping: ResourceMapping;
  private readonly rdnAttribute: string;
  private readonly objectClass: string[];
  private readonly idAttribute: string;
  private readonly maxResults: number;
  private readonly scimPrefix: string;

  constructor(opts: ScimGroupsOptions) {
    this.ldap = opts.ldap;
    this.config = opts.config;
    this.logger = opts.logger;
    this.baseResolver = opts.baseResolver;
    this.users = opts.users;
    this.hooks = opts.hooks;

    this.rdnAttribute =
      (this.config.scim_group_rdn_attribute as string) || 'cn';
    this.objectClass = this.config.scim_group_object_class as string[];
    this.idAttribute = (this.config.scim_id_attribute as string) || 'rdn';
    this.maxResults = (this.config.scim_max_results as number) || 200;
    this.scimPrefix = (this.config.scim_prefix as string) || '/scim/v2';

    const override = (this.config.scim_group_mapping as string) || '';
    this.mapping = mergeMapping(
      DEFAULT_GROUP_MAPPING,
      override ? loadMappingFile(override) : undefined
    );
  }

  private ctx(req?: DmRequest): MappingContext {
    return {
      idAttribute: this.idAttribute,
      rdnAttribute: this.rdnAttribute,
      resourceType: 'Group',
      baseUrl:
        (this.config.scim_base_url as string) ||
        (req?.protocol && req.get
          ? `${req.protocol}://${String(req.get('host') || '')}`
          : ''),
      scimPrefix: this.scimPrefix,
    };
  }

  private dnForId(id: string, req?: DmRequest): string {
    const base = this.baseResolver.groupBase(req);
    return `${this.rdnAttribute}=${escapeDnValue(id)},${base}`;
  }

  /**
   * Resolve an LDAP member DN back to a SCIM reference (for GET responses).
   * Best-effort: extract the RDN value and a guessed type (User if in user base).
   */
  private buildMemberResolver(
    req: DmRequest | undefined
  ): (dn: string) => MultiValued | undefined {
    const userBase = this.baseResolver.userBase(req);
    const groupBase = this.baseResolver.groupBase(req);
    const scimPrefix = this.scimPrefix;
    const baseUrl =
      (this.config.scim_base_url as string) ||
      (req?.protocol && req.get
        ? `${req.protocol}://${String(req.get('host') || '')}`
        : '');
    const userRdn = (this.config.scim_user_rdn_attribute as string) || 'uid';
    const groupRdn = this.rdnAttribute;

    const placeholder =
      (this.config.group_dummy_user as string) || 'cn=fakeuser';
    return (dn: string): MultiValued | undefined => {
      if (!dn) return undefined;
      // Hide the schema-placeholder member from SCIM responses
      if (dn.toLowerCase() === placeholder.toLowerCase()) return undefined;
      // Extract RDN value from DN
      const rdnMatch = /^([^=]+)=((?:\\.|[^,])+)/.exec(dn);
      if (!rdnMatch) return undefined;
      const rdnValue = rdnMatch[2].replace(/\\(.)/g, '$1');
      const lower = dn.toLowerCase();
      let type: 'User' | 'Group' | undefined;
      if (userBase && lower.endsWith(userBase.toLowerCase())) type = 'User';
      else if (groupBase && lower.endsWith(groupBase.toLowerCase()))
        type = 'Group';
      else if (rdnMatch[1] === userRdn) type = 'User';
      else if (rdnMatch[1] === groupRdn) type = 'Group';
      const result: MultiValued = { value: rdnValue };
      if (type) {
        result.type = type;
        if (baseUrl) {
          const endpoint = type === 'User' ? 'Users' : 'Groups';
          result.$ref = `${baseUrl.replace(/\/$/, '')}${scimPrefix}/${endpoint}/${encodeURIComponent(rdnValue)}`;
        }
      }
      return result;
    };
  }

  async get(req: DmRequest, id: string): Promise<ScimGroup> {
    const dn = this.dnForId(id, req);
    let result: SearchResult;
    try {
      result = (await this.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: [...requiredLdapAttributes(this.mapping), 'member'],
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
    return ldapToScimGroup(
      result.searchEntries[0] as AttributesList,
      this.mapping,
      this.ctx(req),
      this.buildMemberResolver(req)
    );
  }

  async list(
    req: DmRequest,
    query: GroupListQuery
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
        const group = await this.get(req, idEquals);
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

    const result = (await this.ldap.search(
      {
        filter: ldapFilter,
        scope: 'sub',
        paged: false,
        attributes: [...requiredLdapAttributes(this.mapping), 'member'],
        sizeLimit: this.maxResults + 1,
      },
      base
    )) as SearchResult;

    const entries = result.searchEntries || [];
    const total = entries.length;
    if (total > this.maxResults) {
      throw scimTooMany(
        `Filter matched ${total} resources, exceeds max ${this.maxResults}`
      );
    }

    const page = entries.slice(startIndex - 1, startIndex - 1 + count);
    const resolver = this.buildMemberResolver(req);
    const resources = page.map(e =>
      ldapToScimGroup(
        e as AttributesList,
        this.mapping,
        this.ctx(req),
        resolver
      )
    );
    return {
      schemas: [SCHEMA_LIST_RESPONSE],
      totalResults: total,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  async create(req: DmRequest, resource: ScimGroup): Promise<ScimGroup> {
    if (!resource.displayName) {
      throw scimInvalidValue('displayName is required');
    }
    const hookInput = await launchHooksChained(this.hooks.scimgroupcreate, [
      resource,
      req,
    ] as [ScimGroup, DmRequest]);
    const group = hookInput[0];

    const { rdn, attributes } = scimGroupToLdap(
      group,
      this.mapping,
      this.objectClass
    );
    if (!rdn) throw scimInvalidValue('displayName is required');
    validateDnValue(rdn, this.rdnAttribute);
    attributes[this.rdnAttribute] = rdn;

    // Resolve members (SCIM value → LDAP DN)
    const memberDns: string[] = [];
    if (group.members && Array.isArray(group.members)) {
      for (const m of group.members) {
        if (!m || !m.value) continue;
        const dn = await this.users.resolveRef(req, m.value);
        if (dn) memberDns.push(dn);
      }
    }
    // groupOfNames requires at least one member
    if (memberDns.length === 0) {
      // Fall back to a placeholder; mirrors --group-dummy-user convention
      const placeholder =
        (this.config.group_dummy_user as string) || 'cn=fakeuser';
      memberDns.push(placeholder);
    }
    attributes.member = memberDns;

    const base = this.baseResolver.groupBase(req);
    const dn = `${this.rdnAttribute}=${escapeDnValue(rdn)},${base}`;

    try {
      await this.ldap.add(dn, attributes);
    } catch (err) {
      if (extractLdapCode(err) === 68) {
        throw scimUniqueness(`Group ${rdn} already exists`);
      }
      throw err;
    }

    const created = await this.get(req, rdn);
    void launchHooks(this.hooks.scimgroupcreatedone, created);
    return created;
  }

  async replace(
    req: DmRequest,
    id: string,
    resource: ScimGroup
  ): Promise<ScimGroup> {
    await this.get(req, id); // ensure exists
    const hookInput = await launchHooksChained(this.hooks.scimgroupupdate, [
      id,
      resource,
      req,
    ] as [string, ScimGroup, DmRequest]);
    const incoming = hookInput[1];

    const { attributes } = scimGroupToLdap(
      incoming,
      this.mapping,
      this.objectClass
    );

    const memberDns: string[] = [];
    if (incoming.members && Array.isArray(incoming.members)) {
      for (const m of incoming.members) {
        if (!m || !m.value) continue;
        const dn = await this.users.resolveRef(req, m.value);
        if (dn) memberDns.push(dn);
      }
    }
    if (memberDns.length === 0) {
      const placeholder =
        (this.config.group_dummy_user as string) || 'cn=fakeuser';
      memberDns.push(placeholder);
    }

    const dn = this.dnForId(id, req);
    const changes: ModifyRequest = { replace: {} };
    for (const [k, v] of Object.entries(attributes)) {
      if (k === 'objectClass' || k === this.rdnAttribute) continue;
      changes.replace![k] = v;
    }
    changes.replace!.member = memberDns;
    await this.ldap.modify(dn, changes);

    const updated = await this.get(req, id);
    void launchHooks(this.hooks.scimgroupupdatedone, id, updated);
    return updated;
  }

  async patch(
    req: DmRequest,
    id: string,
    patch: PatchRequest
  ): Promise<ScimGroup> {
    await this.get(req, id); // ensure exists
    const changes = await patchToModifyRequest(patch, {
      mapping: this.mapping,
      memberAttribute: 'member',
      resolveMemberRef: async value => this.users.resolveRef(req, value),
    });
    if (
      !changes.add &&
      !changes.replace &&
      (!changes.delete ||
        (Array.isArray(changes.delete) && changes.delete.length === 0))
    ) {
      return this.get(req, id);
    }

    // groupOfNames requires at least one member: if a member-remove would empty
    // the attribute, add back the configured placeholder to satisfy the schema.
    const placeholder =
      (this.config.group_dummy_user as string) || 'cn=fakeuser';
    const dn = this.dnForId(id, req);
    if (
      changes.delete &&
      !Array.isArray(changes.delete) &&
      changes.delete.member
    ) {
      const current = (await this.ldap.search(
        { paged: false, scope: 'base', attributes: ['member'] },
        dn
      )) as SearchResult;
      const currentMembers = current.searchEntries[0]?.member;
      const currentArr = Array.isArray(currentMembers)
        ? (currentMembers as string[])
        : currentMembers
          ? [String(currentMembers)]
          : [];
      const toDelete = Array.isArray(changes.delete.member)
        ? (changes.delete.member as string[])
        : [String(changes.delete.member)];
      const remaining = currentArr.filter(m => !toDelete.includes(m));
      if (remaining.length === 0) {
        if (!changes.add) changes.add = {};
        changes.add.member = [placeholder];
      }
    }

    await this.ldap.modify(dn, changes);
    const updated = await this.get(req, id);
    void launchHooks(this.hooks.scimgroupupdatedone, id, updated);
    return updated;
  }

  async delete(req: DmRequest, id: string): Promise<void> {
    await this.get(req, id); // ensure exists
    const hookInput = await launchHooksChained(this.hooks.scimgroupdelete, [
      id,
      req,
    ] as [string, DmRequest]);
    const finalId = hookInput[0];
    const dn = this.dnForId(finalId, req);
    await this.ldap.delete(dn);
    void launchHooks(this.hooks.scimgroupdeletedone, finalId);
  }

  /** Used internally and by Bulk to resolve a Group SCIM reference to a DN. */
  async resolveRef(req: DmRequest, value: string): Promise<string | undefined> {
    if (!value) return undefined;
    const base = this.baseResolver.groupBase(req);
    if (value.includes('=') && value.includes(',')) {
      if (isChildOf(value, base)) return value;
      return undefined;
    }
    const dn = `${this.rdnAttribute}=${escapeDnValue(value)},${base}`;
    try {
      const res = (await this.ldap.search(
        { paged: false, scope: 'base', attributes: ['dn'] },
        dn
      )) as SearchResult;
      if (res.searchEntries && res.searchEntries.length > 0) {
        return res.searchEntries[0].dn;
      }
    } catch {
      // not found directly
    }
    try {
      const res = (await this.ldap.search(
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
    } catch {
      // ignore
    }
    return undefined;
  }

  get groupMapping(): ResourceMapping {
    return this.mapping;
  }
}
