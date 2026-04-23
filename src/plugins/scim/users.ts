/**
 * @module plugins/scim/users
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * SCIM Users resource handler — direct access via ldapActions.
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
  type ScimUser,
  type ListResponse,
  type PatchRequest,
  SCHEMA_LIST_RESPONSE,
} from './types';
import {
  DEFAULT_USER_MAPPING,
  loadMappingFile,
  mergeMapping,
  ldapToScimUser,
  scimUserToLdap,
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

export interface ListQuery {
  filter?: string;
  startIndex?: number;
  count?: number;
  attributes?: string[];
  excludedAttributes?: string[];
  sortBy?: string;
  sortOrder?: 'ascending' | 'descending';
}

export interface ScimUsersOptions {
  ldap: ldapActions;
  config: Config;
  logger: winston.Logger;
  baseResolver: BaseResolver;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  hooks: { [K: string]: Function[] | undefined };
}

export class ScimUsers {
  private readonly ldap: ldapActions;
  private readonly config: Config;
  private readonly logger: winston.Logger;
  private readonly baseResolver: BaseResolver;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private readonly hooks: { [K: string]: Function[] | undefined };
  private readonly mapping: ResourceMapping;
  private readonly rdnAttribute: string;
  private readonly objectClass: string[];
  private readonly idAttribute: string;
  private readonly maxResults: number;
  private readonly scimPrefix: string;

  constructor(opts: ScimUsersOptions) {
    this.ldap = opts.ldap;
    this.config = opts.config;
    this.logger = opts.logger;
    this.baseResolver = opts.baseResolver;
    this.hooks = opts.hooks;

    this.rdnAttribute =
      (this.config.scim_user_rdn_attribute as string) || 'uid';
    this.objectClass = this.config.scim_user_object_class as string[];
    this.idAttribute = (this.config.scim_id_attribute as string) || 'rdn';
    this.maxResults = (this.config.scim_max_results as number) || 200;
    this.scimPrefix = (this.config.scim_prefix as string) || '/scim/v2';

    const override = (this.config.scim_user_mapping as string) || '';
    this.mapping = mergeMapping(
      DEFAULT_USER_MAPPING,
      override ? loadMappingFile(override) : undefined
    );
  }

  private ctx(req?: DmRequest): MappingContext {
    return {
      idAttribute: this.idAttribute,
      rdnAttribute: this.rdnAttribute,
      resourceType: 'User',
      baseUrl:
        (this.config.scim_base_url as string) ||
        (req?.protocol && req.get
          ? `${req.protocol}://${String(req.get('host') || '')}`
          : ''),
      scimPrefix: this.scimPrefix,
    };
  }

  private dnForId(id: string, req?: DmRequest): string {
    const base = this.baseResolver.userBase(req);
    return `${this.rdnAttribute}=${escapeDnValue(id)},${base}`;
  }

  async get(req: DmRequest, id: string): Promise<ScimUser> {
    const dn = this.dnForId(id, req);
    let result: SearchResult;
    try {
      result = (await this.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: requiredLdapAttributes(this.mapping),
        },
        dn
      )) as SearchResult;
    } catch (err) {
      if (extractLdapCode(err) === 32) {
        throw scimNotFound(`User ${id} not found`);
      }
      throw err;
    }
    if (!result.searchEntries || result.searchEntries.length === 0) {
      throw scimNotFound(`User ${id} not found`);
    }
    return ldapToScimUser(
      result.searchEntries[0] as AttributesList,
      this.mapping,
      this.ctx(req)
    );
  }

  async list(
    req: DmRequest,
    query: ListQuery
  ): Promise<ListResponse<ScimUser>> {
    const base = this.baseResolver.userBase(req);
    const startIndex = Math.max(1, query.startIndex || 1);
    const count = Math.min(
      this.maxResults,
      Math.max(0, query.count ?? this.maxResults)
    );

    let ldapFilter = `(${this.objectClass.includes('inetOrgPerson') ? 'objectClass=inetOrgPerson' : `objectClass=${this.objectClass[0]}`})`;
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
      // Short-circuit: id eq "..." → direct base-scope lookup
      try {
        const user = await this.get(req, idEquals);
        return {
          schemas: [SCHEMA_LIST_RESPONSE],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
          Resources: [user],
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
        attributes: requiredLdapAttributes(this.mapping),
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

    // sortBy / sortOrder are parsed for backwards compatibility but not
    // applied — see ServiceProviderConfig.sort.supported = false. Full sort
    // support would require mapping SCIM paths back to LDAP attributes and
    // issuing a server-side ordered search.
    void query.sortBy;
    void query.sortOrder;

    const resources = page.map(e =>
      ldapToScimUser(e as AttributesList, this.mapping, this.ctx(req))
    );

    return {
      schemas: [SCHEMA_LIST_RESPONSE],
      totalResults: total,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }

  async create(req: DmRequest, resource: ScimUser): Promise<ScimUser> {
    if (!resource.userName) {
      throw scimInvalidValue('userName is required');
    }
    const hookInput = await launchHooksChained(this.hooks.scimusercreate, [
      resource,
      req,
    ] as [ScimUser, DmRequest]);
    const user = hookInput[0];

    const { rdn, attributes } = scimUserToLdap(
      user,
      this.mapping,
      this.ctx(req),
      this.objectClass
    );
    if (!rdn) throw scimInvalidValue('userName is required');
    validateDnValue(rdn, this.rdnAttribute);
    attributes[this.rdnAttribute] = rdn;

    const base = this.baseResolver.userBase(req);
    const dn = `${this.rdnAttribute}=${escapeDnValue(rdn)},${base}`;

    try {
      await this.ldap.add(dn, attributes);
    } catch (err) {
      if (extractLdapCode(err) === 68) {
        throw scimUniqueness(`User ${rdn} already exists`);
      }
      throw err;
    }

    const created = await this.get(req, rdn);
    void launchHooks(this.hooks.scimusercreatedone, [created]);
    return created;
  }

  async replace(
    req: DmRequest,
    id: string,
    resource: ScimUser
  ): Promise<ScimUser> {
    const dn = this.dnForId(id, req);
    // Fetch current LDAP entry so we only delete attributes that actually
    // exist on the entry (avoids noSuchAttribute errors on atomic modify).
    const currentResult = (await this.ldap.search(
      {
        paged: false,
        scope: 'base',
        attributes: requiredLdapAttributes(this.mapping),
      },
      dn
    )) as SearchResult;
    if (!currentResult.searchEntries?.length) {
      throw scimNotFound(`User ${id} not found`);
    }
    const currentEntry = currentResult.searchEntries[0] as AttributesList;

    const hookInput = await launchHooksChained(this.hooks.scimuserupdate, [
      id,
      resource,
      req,
    ] as [string, ScimUser, DmRequest]);
    const incoming = hookInput[1];

    const { attributes } = scimUserToLdap(
      incoming,
      this.mapping,
      this.ctx(req),
      this.objectClass
    );
    const changes: ModifyRequest = { replace: {}, delete: [] };
    const skipAttrs = new Set([
      'objectClass',
      'entryUUID',
      'createTimestamp',
      'modifyTimestamp',
      this.rdnAttribute,
    ]);
    const hasAttrValue = (v: unknown): boolean => {
      if (v == null) return false;
      if (typeof v === 'string') return v.length > 0;
      if (Array.isArray(v)) return v.length > 0 && v.some(x => x != null);
      return true;
    };
    for (const attr of requiredLdapAttributes(this.mapping)) {
      if (skipAttrs.has(attr)) continue;
      if (attributes[attr] != null) {
        changes.replace![attr] = attributes[attr];
      } else if (hasAttrValue(currentEntry[attr])) {
        (changes.delete as string[]).push(attr);
      }
    }
    if (Object.keys(changes.replace || {}).length === 0) delete changes.replace;
    if ((changes.delete as string[]).length === 0) delete changes.delete;

    if (changes.replace || changes.delete) {
      try {
        await this.ldap.modify(dn, changes);
      } catch (err) {
        if (extractLdapCode(err) !== 16) throw err;
      }
    }

    const updated = await this.get(req, id);
    void launchHooks(this.hooks.scimuserupdatedone, [id, updated]);
    return updated;
  }

  async patch(
    req: DmRequest,
    id: string,
    patch: PatchRequest
  ): Promise<ScimUser> {
    await this.get(req, id); // ensure exists
    const changes = await patchToModifyRequest(patch, {
      mapping: this.mapping,
    });
    if (
      !changes.add &&
      !changes.replace &&
      (!changes.delete ||
        (Array.isArray(changes.delete) && changes.delete.length === 0))
    ) {
      return this.get(req, id);
    }
    const dn = this.dnForId(id, req);
    await this.ldap.modify(dn, changes);
    const updated = await this.get(req, id);
    void launchHooks(this.hooks.scimuserupdatedone, [id, updated]);
    return updated;
  }

  async delete(req: DmRequest, id: string): Promise<void> {
    await this.get(req, id); // ensure exists
    const hookInput = await launchHooksChained(this.hooks.scimuserdelete, [
      id,
      req,
    ] as [string, DmRequest]);
    const finalId = hookInput[0];
    const dn = this.dnForId(finalId, req);
    await this.ldap.delete(dn);
    void launchHooks(this.hooks.scimuserdeletedone, [finalId]);
  }

  /**
   * Given a SCIM member value (typically an id), return the LDAP DN.
   * Used by Groups PATCH and Bulk reference resolution.
   */
  async resolveRef(req: DmRequest, value: string): Promise<string | undefined> {
    if (!value) return undefined;
    const base = this.baseResolver.userBase(req);
    // Client-supplied DN: only accept when it falls under the tenant's base,
    // otherwise a client could reference an entry outside its own subtree.
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
      // not found by DN; try a filter
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

  get userMapping(): ResourceMapping {
    return this.mapping;
  }
}
