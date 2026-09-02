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
  resolveLockConfig,
  type MappingContext,
} from './mapping';
import { scimFilterToLdap } from './filter';
import { pagedSearch } from './list';
import { patchToModifyRequest } from './patch';
import {
  scimInvalidValue,
  scimNotFound,
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

/** Does this change set write or clear the attribute backing `active`? */
function touchesLock(changes: ModifyRequest, lockAttribute: string): boolean {
  if (changes.replace && lockAttribute in changes.replace) return true;
  if (changes.add && lockAttribute in changes.add) return true;
  const del = changes.delete;
  if (Array.isArray(del)) return del.includes(lockAttribute);
  if (del && typeof del === 'object') return lockAttribute in del;
  return false;
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
  private readonly maxScanned: number;
  private readonly scimPrefix: string;
  private readonly lockAttribute: string;
  private readonly lockValue: string;

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
    this.maxScanned = (this.config.scim_max_scanned as number) || 10000;
    this.scimPrefix = (this.config.scim_prefix as string) || '/scim/v2';
    const lock = resolveLockConfig(
      (this.config.scim_user_lock_attribute as string) || '',
      (this.config.scim_user_lock_value as string) || ''
    );
    this.lockAttribute = lock.attribute;
    this.lockValue = lock.value;

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
      lockAttribute: this.lockAttribute,
      lockValue: this.lockValue,
    };
  }

  /**
   * LDAP attributes to fetch. The lock attribute backing SCIM `active` is
   * operational on most directories, so it is never returned unless asked
   * for by name.
   */
  private ldapAttributes(): string[] {
    return requiredLdapAttributes(this.mapping, [this.lockAttribute]);
  }

  private dnForId(id: string, req?: DmRequest): string {
    const base = this.baseResolver.userBase(req);
    return `${this.rdnAttribute}=${escapeDnValue(id)},${base}`;
  }

  async get(req: DmRequest, id: string): Promise<ScimUser> {
    const dn = this.dnForId(id, req);
    let result: SearchResult;
    try {
      result = (await this.ldap.forRequest(req).search(
        {
          paged: false,
          scope: 'base',
          attributes: this.ldapAttributes(),
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
      const translated = scimFilterToLdap(query.filter, this.mapping, {
        lockAttribute: this.lockAttribute,
        supportsActive: true,
      });
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

    const { entries, totalResults } = await pagedSearch({
      directory: this.ldap.forRequest(req),
      base,
      filter: ldapFilter,
      attributes: this.ldapAttributes(),
      startIndex,
      count,
      maxScanned: this.maxScanned,
    });

    // sortBy / sortOrder are parsed for backwards compatibility but not
    // applied — see ServiceProviderConfig.sort.supported = false. Full sort
    // support would require mapping SCIM paths back to LDAP attributes and
    // issuing a server-side ordered search.
    void query.sortBy;
    void query.sortOrder;

    const resources = entries.map(e =>
      ldapToScimUser(e, this.mapping, this.ctx(req))
    );

    return {
      schemas: [SCHEMA_LIST_RESPONSE],
      totalResults,
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
      await this.ldap.forRequest(req).add(dn, attributes);
    } catch (err) {
      if (extractLdapCode(err) === 68) {
        throw scimUniqueness(`User ${rdn} already exists`);
      }
      // The lock attribute is written here whenever the body said
      // `active: false`, and a directory without the schema for it refuses
      // the whole add.
      if (attributes[this.lockAttribute] !== undefined) {
        throw this.lockSchemaError(err);
      }
      throw err;
    }

    const created = await this.get(req, rdn);
    void launchHooks(this.hooks.scimusercreatedone, created);
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
    const currentResult = (await this.ldap.forRequest(req).search(
      {
        paged: false,
        scope: 'base',
        attributes: this.ldapAttributes(),
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

    const { attributes, active } = scimUserToLdap(
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
      // The lock attribute is not a mapped attribute: `active` decides it,
      // below, and a body that says nothing about `active` must leave it
      // alone. Clearing it here would silently release a lock the directory
      // owns — a ppolicy auto-lockout, or one an administrator set.
      this.lockAttribute,
    ]);
    const hasAttrValue = (v: unknown): boolean => {
      if (v == null) return false;
      if (typeof v === 'string') return v.length > 0;
      if (Array.isArray(v)) return v.length > 0 && v.some(x => x != null);
      return true;
    };
    for (const attr of this.ldapAttributes()) {
      if (skipAttrs.has(attr)) continue;
      if (attributes[attr] != null) {
        changes.replace![attr] = attributes[attr];
      } else if (hasAttrValue(currentEntry[attr])) {
        (changes.delete as string[]).push(attr);
      }
    }
    // `active` is a full-replace attribute like any other, but only when the
    // body actually carries it. RFC 7644 section 3.5.1 would have omission
    // clear it; here that would defeat a lockout no SCIM client set, so
    // omission means "unchanged" and the deviation is documented.
    if (active === false) {
      changes.replace![this.lockAttribute] = this.lockValue;
    } else if (
      active === true &&
      hasAttrValue(currentEntry[this.lockAttribute])
    ) {
      (changes.delete as string[]).push(this.lockAttribute);
    }

    if (Object.keys(changes.replace || {}).length === 0) delete changes.replace;
    if ((changes.delete as string[]).length === 0) delete changes.delete;

    if (changes.replace || changes.delete) {
      // An LDAP modify is atomic: noSuchAttribute (0x10) means *nothing* was
      // applied. Swallowing it was meant to absorb a delete of an attribute
      // the snapshot said was there and the entry no longer holds — but with
      // `active` in the same change set it answered 200 to a deactivation
      // the directory had rolled back, and the account kept binding. The
      // deletes are already derived from the snapshot, so a 16 here is a
      // concurrent modification, not a routine no-op: report it.
      try {
        await this.ldap.forRequest(req).modify(dn, changes);
      } catch (err) {
        if (active !== undefined) throw this.lockSchemaError(err);
        if (extractLdapCode(err) !== 16) throw err;
        throw new ScimError(
          409,
          `${dn} changed while this PUT was being applied; nothing was ` +
            `written. Retry the request.`
        );
      }
    }

    const updated = await this.get(req, id);
    void launchHooks(this.hooks.scimuserupdatedone, id, updated);
    return updated;
  }

  async patch(
    req: DmRequest,
    id: string,
    patch: PatchRequest
  ): Promise<ScimUser> {
    const dn = this.dnForId(id, req);
    const current = await this.currentEntry(req, id); // ensure exists
    const changes = await patchToModifyRequest(patch, {
      mapping: this.mapping,
      lockAttribute: this.lockAttribute,
      lockValue: this.lockValue,
      supportsActive: true,
      current,
    });
    // An empty change set still goes to ldapActions rather than returning
    // early: `ldapmodifyrequest` — where write permission is checked — runs
    // before the changes are examined, and an empty one touches the
    // directory not at all. Answering 200 without it told a caller with no
    // write permission that its write had succeeded.
    //
    // `req` must reach ldapActions: the authorization plugins hook
    // `ldapmodifyrequest` and skip every check when it is missing.
    try {
      await this.ldap.forRequest(req).modify(dn, changes);
    } catch (err) {
      if (touchesLock(changes, this.lockAttribute)) {
        throw this.lockSchemaError(err);
      }
      throw err;
    }
    const updated = await this.get(req, id);
    void launchHooks(this.hooks.scimuserupdatedone, id, updated);
    return updated;
  }

  /**
   * Re-raise a directory refusal that names the schema, pointing at the flag
   * that caused it.
   *
   * The generic translation in `errors` cannot do this: it sees the error,
   * not the configuration. Only this class knows which attribute was
   * configured to back `active`, and the shipped default —
   * `pwdAccountLockedTime` — exists only where slapd loads the ppolicy
   * overlay, which is the common way to meet this.
   */
  private lockSchemaError(err: unknown): unknown {
    const code = extractLdapCode(err);
    if (code !== 17 && code !== 65) return err;
    const message = err instanceof Error ? err.message : String(err);
    return scimInvalidValue(
      `The directory rejected '${this.lockAttribute}', the attribute backing ` +
        `'active': ${message}. Point --scim-user-lock-attribute and ` +
        `--scim-user-lock-value at an attribute this directory defines ` +
        `(nsAccountLock / TRUE on 389-ds); the default needs the ppolicy ` +
        `overlay.`
    );
  }

  /** Fetch the raw LDAP entry backing a SCIM id, or raise 404. */
  private async currentEntry(
    req: DmRequest,
    id: string
  ): Promise<AttributesList> {
    const dn = this.dnForId(id, req);
    let result: SearchResult;
    try {
      result = (await this.ldap
        .forRequest(req)
        .search(
          { paged: false, scope: 'base', attributes: this.ldapAttributes() },
          dn
        )) as SearchResult;
    } catch (err) {
      if (extractLdapCode(err) === 32) {
        throw scimNotFound(`User ${id} not found`);
      }
      throw err;
    }
    if (!result.searchEntries?.length) {
      throw scimNotFound(`User ${id} not found`);
    }
    return result.searchEntries[0] as AttributesList;
  }

  async delete(req: DmRequest, id: string): Promise<void> {
    await this.get(req, id); // ensure exists
    const hookInput = await launchHooksChained(this.hooks.scimuserdelete, [
      id,
      req,
    ] as [string, DmRequest]);
    const finalId = hookInput[0];
    const dn = this.dnForId(finalId, req);
    await this.ldap.forRequest(req).delete(dn);
    void launchHooks(this.hooks.scimuserdeletedone, finalId);
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
      const res = (await this.ldap
        .forRequest(req)
        .search(
          { paged: false, scope: 'base', attributes: ['dn'] },
          dn
        )) as SearchResult;
      if (res.searchEntries && res.searchEntries.length > 0) {
        return res.searchEntries[0].dn;
      }
    } catch (err) {
      // Only "no such object" is a miss. Anything else — an authorization
      // refusal, a broken connection — must not be read as an absent member,
      // which would silently drop the reference from the group.
      if (extractLdapCode(err) !== 32) throw err;
      // Not there under that DN; try a filter.
    }
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

  get userMapping(): ResourceMapping {
    return this.mapping;
  }
}
