/**
 * @module plugins/twake/groups
 *
 * Organization groups: `core/ldap/groups`, with one group branch per
 * organization. A group's members belong to its organization, whichever API
 * writes it, and a tombstone is hidden from the member lists it still holds.
 *
 * See `docs/usage/plugins/integrations/groups.md`.
 */
import { randomUUID } from 'node:crypto';

import type { Express, Request, Response } from 'express';
import type { SearchOptions } from 'ldapts';

import type { DM } from '../../bin';
import type { Schema, SchemaAttribute } from '../../config/schema';
import type { Hooks } from '../../hooks';
import { AUTHZ_REFUSED, BadRequestError, HttpError } from '../../lib/errors';
import { extractLdapCode } from '../../lib/ldapCodes';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import {
  escapeDnValue,
  escapeLdapFilter,
  isDummyMemberDn,
  isAuthzRefusal,
  normalizeDn,
  parseDn,
  unescapeDnValue,
} from '../../lib/utils';
import LdapGroups from '../ldap/groups';
import { BaseResolver } from '../scim/baseResolver';
import {
  DEFAULT_GROUP_MAPPING,
  loadMappingFile,
  mergeMapping,
} from '../scim/mapping';
import type { ScimGroup } from '../scim/types';

import {
  first,
  lifecycleAttributes,
  valueOf,
  type LifecycleAttributes,
} from './lifecycleAttributes';

/**
 * An attribute's first value, whatever case its name is configured in: the
 * directory answers it under its schema's spelling.
 */
export const read = (
  entry: AttributesList,
  attribute: string
): string | undefined => first(valueOf(entry, attribute));

export const ORG = '{org}';

const GROUP_SORT = ['displayName', 'description', 'createdAt'];
const MEMBER_SORT = ['uid', 'displayName', 'mail', 'jobTitle'];

/** A member's public profile: its fields, and the attribute each reads. */
const MEMBER_FIELDS: Record<string, string> = {
  uid: 'uid',
  _id: 'entryUUID',
  cn: 'cn',
  sn: 'sn',
  givenName: 'givenName',
  displayName: 'displayName',
  mail: 'mail',
  mobile: 'mobile',
  jobTitle: 'twakeJobTitle',
  company: 'twakeCompany',
  organizationRole: 'twakeOrganizationRole',
  organizationId: 'twakeOrganizationId',
};
const NAME_FIELDS: Record<string, string> = {
  familyName: 'sn',
  givenName: 'givenName',
  additionalName: 'twakeAdditionalName',
  namePrefix: 'twakeNamePrefix',
};
const TECHNICAL = 'twakeIsTechnical';

/** A refusal the routes answer as `{ error, code }`. */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export const notFound = (what: string): RouteError =>
  new RouteError(
    404,
    `${what[0].toUpperCase()}${what.slice(1)} not found`,
    `${what.toUpperCase()}_NOT_FOUND`
  );
export const invalid = (message: string, code = 'INVALID_INPUT'): RouteError =>
  new RouteError(400, message, code);

export const NAME_RULE =
  'name must be a non-blank string of at most 256 characters with no control characters';

export function isDisplayName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 256 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(name)
  );
}

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isColor = (color: unknown): color is string =>
  typeof color === 'string' && COLOR.test(color);

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** A request without a JSON object body leaves `req.body` undefined. */
export function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw invalid('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

export interface Page {
  page: number;
  limit: number;
  offset: number;
  search?: string;
  sortBy?: string;
  desc: boolean;
}

/** The values of an attribute, whatever shape the directory gave them. */
export function values(value: AttributeValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(v => v.toString());
}

/** A DN spelled one way, to compare two spellings of it. */
export function dnKey(dn: string): string {
  try {
    return normalizeDn(dn);
  } catch {
    return dn.toLowerCase();
  }
}

export function parentOf(dn: string): string {
  return parseDn(dn).slice(1).join(',');
}

/** The RDN value of a DN, unescaped, or the DN itself if it has none. */
export function rdnValue(dn: string): string {
  const [rdn] = parseDn(dn);
  const eq = rdn.indexOf('=');
  return eq > 0 ? unescapeDnValue(rdn.slice(eq + 1).trim()) : dn;
}

/**
 * The entries one level under a DN pattern holding `{org}`, the organization
 * captured as one RDN value: `(?:\\.|[^,])+` keeps an escaped comma inside it.
 */
export function branchPattern(base: string): RegExp {
  const [before, after] = parseDn(base)
    .join(',')
    .split(ORG)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${before}(?<org>(?:\\\\.|[^,])+)${after}$`, 'i');
}

/**
 * The organization a rename moves an entry into, under a branch pattern, if
 * it changes the entry's parent: what it holds comes along unchecked.
 */
export function movedInto(
  pattern: RegExp,
  dn: string,
  newDn: string
): string | undefined {
  const org = organizationIn(pattern, newDn);
  return org !== undefined && dnKey(parentOf(newDn)) !== dnKey(parentOf(dn))
    ? org
    : undefined;
}

/** Search options whose member lists keep the tombstones they hold. */
const WHOLE = Symbol('whole member lists');

/** The organization of an entry one level under a branch pattern. */
export function organizationIn(
  pattern: RegExp,
  dn: string
): string | undefined {
  const m = pattern.exec(parentOf(parseDn(dn).join(',')));
  return m?.groups ? unescapeDnValue(m.groups.org) : undefined;
}

export default class TwakeGroups extends LdapGroups {
  name = 'twakeGroups';

  protected readonly groupBase: string;
  protected readonly userBase: string;
  protected readonly groupPattern: RegExp;
  protected readonly attrs: LifecycleAttributes;
  private readonly orgPattern: string;
  private readonly displayName: string;
  private readonly color: string;
  private readonly createdAt: string;
  readonly maxPage: number;
  private readonly memberFields: Record<string, string>;

  constructor(server: DM) {
    super(server);
    this.groupBase = this.config.twake_group_base || '';
    this.userBase = this.config.twake_group_user_base || '';
    for (const [option, pattern] of [
      ['--twake-group-base', this.groupBase],
      ['--twake-group-user-base', this.userBase],
    ])
      if (!pattern.includes(ORG))
        throw new Error(`${this.name}: ${option} must hold ${ORG}`);
    this.groupPattern = branchPattern(this.groupBase);
    this.attrs = lifecycleAttributes(this.config);
    this.orgPattern = this.config.twake_group_organization_dn || '';
    this.displayName =
      this.config.twake_group_display_name_attribute || 'twakeDisplayName';
    this.color = this.config.twake_group_color_attribute || 'twakeGroupColor';
    this.createdAt =
      this.config.twake_group_created_at_attribute || 'twakeCreatedAt';
    this.maxPage = this.config.twake_group_max_page_limit || 1000;
    this.memberFields = {
      ...MEMBER_FIELDS,
      ...this.config.twake_group_member_fields,
    };
  }

  /**
   * Declare the group attributes under their configured names, whatever case
   * the schema spells them in, or add them when it does not: the schema does
   * not have to follow a renamed attribute.
   */
  protected adaptSchema(schema: Schema): Schema {
    const own: Record<string, SchemaAttribute> = {
      [this.displayName]: { type: 'string', required: true },
      [this.color]: { type: 'string', test: COLOR.source },
      [this.createdAt]: { type: 'string' },
    };
    for (const [name, spec] of Object.entries(own)) {
      const key = Object.keys(schema.attributes).find(
        k => k.toLowerCase() === name.toLowerCase()
      );
      const declared = key ? schema.attributes[key] : spec;
      if (key) delete schema.attributes[key];
      schema.attributes[name] = declared;
    }
    return schema;
  }

  /**
   * No `ldapdeletedone`: an erased member leaves its groups through the
   * directory's referential integrity, whatever made the delete. The cleanup
   * inherited from core/ldap/groups writes through LDAP-Rest, so every group
   * would announce a member removed on an erase, which publishes nothing.
   */
  hooks: Hooks = {
    ldapaddrequest: ([dn, entry, req]) => {
      this.checkMembers(dn, entry.member);
      // A group written without the routes, through SCIM, is dated too. Only
      // one holding the display name: its classes then allow the date, which
      // a plain groupOfNames would refuse.
      if (
        this.organizationOf(dn) !== undefined &&
        valueOf(entry, this.displayName) !== undefined &&
        valueOf(entry, this.createdAt) === undefined
      )
        entry = { ...entry, [this.createdAt]: new Date().toISOString() };
      return [dn, entry, req];
    },
    ldapmodifyrequest: ([dn, changes, op, req]) => {
      this.checkMembers(dn, changes.add?.member);
      this.checkMembers(dn, changes.replace?.member);
      return [dn, changes, op, req];
    },
    // A group moved to another organization takes its members along, the
    // tombstones it hides too. The refusal names none: the caller may not
    // be allowed to read them.
    ldaprenamerequest: async ([dn, newDn, req]) => {
      const org = movedInto(this.groupPattern, dn, newDn);
      if (org === undefined) return [dn, newDn, req];
      let members: AttributeValue | undefined;
      try {
        const { searchEntries } = (await this.ldap.search(
          {
            paged: false,
            scope: 'base',
            attributes: ['member'],
            [WHOLE]: true,
          } as SearchOptions,
          dn
        )) as SearchResult;
        members = searchEntries[0]?.member;
      } catch (err) {
        if (extractLdapCode(err) !== 32) throw err;
      }
      if (this.foreign(org, members) !== undefined)
        throw new BadRequestError(
          `The group holds members of another organization than ${org}`
        );
      return [dn, newDn, req];
    },
    ldapsearchfilter: async ([result, req, opts]) => [
      (opts as { [WHOLE]?: boolean } | undefined)?.[WHOLE]
        ? result
        : await this.hideTombstones(result),
      req,
      opts,
    ],
    // A SCIM group of an organization gets a generated cn, as one made by
    // the routes does.
    scimgroupcreate: ([group, req, base]: [ScimGroup, Request, string?]) => {
      // A hook written for the two-element form drops the base
      base ??= new BaseResolver(this.config).groupBase(req);
      return [
        this.groupPattern.test(parseDn(base).join(','))
          ? { ...group, id: randomUUID() }
          : group,
        req,
        base,
      ];
    },
  };

  /**
   * The id a `scimgroupcreate` hook assigns names the entry only when the
   * SCIM group mapping leaves the RDN attribute alone.
   */
  afterLoad(): void {
    if (!this.server.loadedPlugins.scim) return;
    const rdn = (this.config.scim_group_rdn_attribute as string) || 'cn';
    const override = (this.config.scim_group_mapping as string) || '';
    const writer = mergeMapping(
      DEFAULT_GROUP_MAPPING,
      override ? loadMappingFile(override) : undefined
    ).entries.find(e => e.ldap?.toLowerCase() === rdn.toLowerCase());
    if (writer)
      this.logger.warn(
        `${this.name}: the SCIM group mapping writes ${writer.scim} to ${rdn}, ` +
          `so SCIM groups keep it as their RDN instead of a generated cn: ` +
          `map ${writer.scim} to another attribute with --scim-group-mapping`
      );
  }

  /** The organization a group DN belongs to, if it is a group at all. */
  organizationOf(dn: string): string | undefined {
    return organizationIn(this.groupPattern, dn);
  }

  groupBaseOf(org: string): string {
    return this.groupBase.replace(ORG, escapeDnValue(org));
  }

  userBaseOf(org: string): string {
    return this.userBase.replace(ORG, escapeDnValue(org));
  }

  /**
   * A group's members belong to its organization, as a provider is trusted
   * within its own organization only. The placeholder belongs to none.
   */
  private checkMembers(dn: string, members: AttributeValue | undefined): void {
    const org = this.organizationOf(dn);
    if (!org) return;
    const member = this.foreign(org, members);
    if (member !== undefined)
      throw new BadRequestError(
        `${member} is not a user of organization ${org}`
      );
  }

  /** A member that is not a user of the organization, if any. */
  private foreign(
    org: string,
    members: AttributeValue | undefined
  ): string | undefined {
    const users = dnKey(this.userBaseOf(org));
    return values(members).find(
      member =>
        !isDummyMemberDn(member, this.config.group_dummy_user) &&
        dnKey(parentOf(member)) !== users
    );
  }

  /**
   * A tombstone keeps its memberships until it is erased, and is hidden from
   * them, so every API reads the same member list.
   */
  private async hideTombstones(result: SearchResult): Promise<SearchResult> {
    if (!this.attrs.deleted) return result;
    const orgs = new Set<string>();
    for (const entry of result.searchEntries) {
      const org = this.organizationOf(entry.dn);
      if (org && entry.member !== undefined) orgs.add(org);
    }
    if (orgs.size === 0) return result;
    const hidden = new Set<string>();
    for (const org of orgs)
      for (const dn of await this.tombstonesOf(org)) hidden.add(dnKey(dn));
    if (hidden.size === 0) return result;
    return {
      ...result,
      searchEntries: result.searchEntries.map(entry =>
        entry.member === undefined || !this.organizationOf(entry.dn)
          ? entry
          : {
              ...entry,
              member: values(entry.member).filter(m => !hidden.has(dnKey(m))),
            }
      ),
    };
  }

  /**
   * Read without a request: hiding a tombstone is integrity, not data, and
   * must not depend on what the caller may see.
   */
  async tombstonesOf(org: string): Promise<string[]> {
    const { deleted, deletedValue } = this.attrs;
    if (!deleted) return [];
    try {
      const { searchEntries } = (await this.ldap.search(
        {
          paged: false,
          scope: 'one',
          filter: `(${deleted}=${escapeLdapFilter(deletedValue)})`,
          attributes: ['dn'],
        },
        this.userBaseOf(org)
      )) as SearchResult;
      return searchEntries.map(e => e.dn);
    } catch (err) {
      if (extractLdapCode(err) === 32) return [];
      throw err;
    }
  }

  /**
   * Only the organization routes: the flat `/v1/ldap/groups` of
   * core/ldap/groups would read one base that holds no group here.
   */
  api(app: Express): void {
    const base = `${this.config.api_prefix}/v1/organizations/:id/groups`;
    const route = this.organizationRoute.bind(this);
    app.get(
      base,
      route('listing groups', (q, r, o) => this.listRoute(q, r, o))
    );
    app.post(
      base,
      route('creating group', (q, r, o) => this.createRoute(q, r, o))
    );
    app.get(
      `${base}/:groupId`,
      route('getting group', async (req, res, org) => {
        const group = await this.readGroup(org, req.params.groupId as string);
        if (!group) throw notFound('group');
        res.json(group);
      })
    );
    app.get(
      `${base}/:groupId/members`,
      route('listing group members', (q, r, o) => this.membersRoute(q, r, o))
    );
    app.patch(
      `${base}/:groupId`,
      route('updating group', (q, r, o) => this.updateRoute(q, r, o))
    );
    app.delete(
      `${base}/:groupId`,
      route('deleting group', async (req, res, org) => {
        await this.onGroup(() =>
          this.deleteGroup(this.groupDn(org, req.params.groupId as string), req)
        );
        res.json({ success: true });
      })
    );
    app.post(
      `${base}/:groupId/members`,
      route('adding group members', (q, r, o) => this.addMembersRoute(q, r, o))
    );
    app.delete(
      `${base}/:groupId/members/:userId`,
      route('removing group member', (q, r, o) =>
        this.removeMemberRoute(q, r, o)
      )
    );
  }

  /** A route of the organization `:id`; see `RouteError` for refusals. */
  organizationRoute(
    context: string,
    handler: (req: Request, res: Response, org: string) => Promise<void>,
    plugin = this.name
  ): (req: Request, res: Response) => Promise<void> {
    return async (req, res) => {
      try {
        const org = req.params.id as string;
        await this.checkOrganization(org);
        await handler(req, res, org);
      } catch (err) {
        if (err instanceof RouteError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        // An authorization plugin refused, maybe through a plain Error:
        // answered without the branch it names
        if (isAuthzRefusal(err)) {
          res.status(403).json({ error: AUTHZ_REFUSED, code: 'REFUSED' });
          return;
        }
        // A rule of another plugin or of the schema refused the write
        if (err instanceof HttpError && err.statusCode < 500) {
          res.status(err.statusCode).json({
            error: err.message,
            code: err.statusCode === 400 ? 'INVALID_INPUT' : 'REFUSED',
          });
          return;
        }
        this.logger.error({ plugin, context, error: String(err) });
        res
          .status(500)
          .json({ error: `Error ${context}`, code: 'INTERNAL_ERROR' });
      }
    };
  }

  groupDn(org: string, id: string): string {
    return `${this.cn}=${escapeDnValue(id)},${this.groupBaseOf(org)}`;
  }

  get userAttribute(): string {
    return this.config.ldap_user_main_attribute || 'uid';
  }

  userDn(org: string, username: string): string {
    return `${this.userAttribute}=${escapeDnValue(username)},${this.userBaseOf(org)}`;
  }

  /** Every route answers 404 for a missing organization, 410 for a deleted one. */
  async checkOrganization(org: string): Promise<void> {
    if (!this.orgPattern) return;
    const status =
      this.config.twake_group_organization_status_attribute || 'twakeOrgStatus';
    let entry: AttributesList | undefined;
    try {
      const found = (await this.ldap.search(
        { paged: false, scope: 'base', attributes: [status] },
        this.orgPattern.replace(ORG, escapeDnValue(org))
      )) as SearchResult;
      entry = found.searchEntries[0];
    } catch (err) {
      if (extractLdapCode(err) !== 32) throw err;
    }
    if (!entry) throw notFound('organization');
    const deleted =
      this.config.twake_group_organization_deleted_value || 'deleted';
    if (read(entry, status) === deleted)
      throw new RouteError(
        410,
        'Organization has been deleted',
        'ORGANIZATION_DELETED'
      );
  }

  /** Page, search and sort of a list route, or a refusal of them. */
  page(req: Request, sortable: string[]): Page {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(
      1,
      Math.min(parseInt(req.query.limit as string) || 20, this.maxPage)
    );
    // An empty search box sends `search=`: that is no search, not a short one
    const search = (req.query.search as string | undefined) || undefined;
    if (
      search !== undefined &&
      (typeof search !== 'string' || search.length < 2)
    )
      throw invalid(
        'Search query must be at least 2 characters',
        'INVALID_SEARCH_QUERY'
      );
    const sortBy = req.query.sortBy as string | undefined;
    if (sortBy !== undefined && !sortable.includes(sortBy))
      throw invalid(
        `sortBy must be one of: ${sortable.join(', ')}`,
        'INVALID_SORT_FIELD'
      );
    return {
      page,
      limit,
      offset: (page - 1) * limit,
      search,
      sortBy,
      desc: req.query.sortOrder === 'desc',
    };
  }

  sorted<T extends Record<string, unknown>>(
    items: T[],
    sortBy: string | undefined,
    desc: boolean
  ): T[] {
    if (!sortBy) return items;
    const direction = desc ? -1 : 1;
    return items.sort(
      (a, b) => text(a[sortBy]).localeCompare(text(b[sortBy])) * direction
    );
  }

  /** A group as the routes answer it: members named by their RDN value. */
  groupOf(org: string, entry: AttributesList): Record<string, unknown> {
    const cn = read(entry, this.cn) || '';
    const users = dnKey(this.userBaseOf(org));
    const members = values(entry.member)
      .filter(m => !isDummyMemberDn(m, this.config.group_dummy_user))
      .map(m => (dnKey(parentOf(m)) === users ? rdnValue(m) : m));
    return {
      id: cn,
      cn,
      displayName: read(entry, this.displayName) ?? cn,
      description: read(entry, 'description'),
      color: read(entry, this.color),
      organizationId: org,
      baseDN: this.groupDn(org, cn),
      members,
      createdAt: read(entry, this.createdAt),
    };
  }

  async groups(
    org: string,
    filter: string,
    attributes?: string[],
    req?: Request
  ): Promise<AttributesList[]> {
    try {
      const { searchEntries } = (await this.ldap.search(
        {
          paged: false,
          scope: 'one',
          filter,
          ...(attributes && { attributes }),
        },
        this.groupBaseOf(org),
        req
      )) as SearchResult;
      return searchEntries;
    } catch (err) {
      if (extractLdapCode(err) === 32) return [];
      throw err;
    }
  }

  private async readGroup(
    org: string,
    id: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const { searchEntries } = (await this.ldap.search(
        { paged: false, scope: 'base' },
        this.groupDn(org, id)
      )) as SearchResult;
      return searchEntries[0] && this.groupOf(org, searchEntries[0]);
    } catch (err) {
      if (extractLdapCode(err) === 32) return undefined;
      throw err;
    }
  }

  /** The group of that display name in the organization, if any. */
  private async named(org: string, name: string): Promise<string | undefined> {
    const [entry] = await this.groups(
      org,
      `(${this.displayName}=${escapeLdapFilter(name)})`
    );
    return entry && read(entry, this.cn);
  }

  /** A write to a group that is not there answers 404. */
  private async onGroup<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (extractLdapCode(err) === 32) throw notFound('group');
      throw err;
    }
  }

  private async listRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const p = this.page(req, GROUP_SORT);
    let filter = `(${this.cn}=*)`;
    if (p.search) {
      const s = escapeLdapFilter(p.search);
      // The cn stands in for a missing display name, as in groupOf(); it is
      // not searched otherwise, being a UUID for groups made here.
      filter = `(&${filter}(|(${this.displayName}=*${s}*)(description=*${s}*)(&(!(${this.displayName}=*))(${this.cn}=*${s}*))))`;
    }
    const groups = this.sorted(
      (await this.groups(org, filter)).map(e => this.groupOf(org, e)),
      p.sortBy,
      p.desc
    );
    res.json({
      organizationId: org,
      groups: groups.slice(p.offset, p.offset + p.limit),
      pagination: {
        page: p.page,
        limit: p.limit,
        total: groups.length,
        totalPages: Math.ceil(groups.length / p.limit),
      },
    });
  }

  private async createRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const body = bodyOf(req);
    if (!isDisplayName(body.name)) throw invalid(NAME_RULE);
    if (body.description !== undefined && typeof body.description !== 'string')
      throw invalid('description must be a string');
    if (body.color !== undefined && !isColor(body.color))
      throw invalid('color must be a hex code (e.g. #RRGGBB or #RGB)');
    // Unique for groups made here only: a provider may push two of one name.
    if (await this.named(org, body.name))
      throw new RouteError(409, 'Group already exists', 'GROUP_EXISTS');
    const id = randomUUID();
    const additional: AttributesList = {
      objectClass: this.config.group_class || ['top', 'groupOfNames'],
      [this.displayName]: body.name,
      [this.createdAt]: new Date().toISOString(),
    };
    if (body.description) additional.description = body.description;
    if (body.color) additional[this.color] = body.color;
    await this.addGroup(this.groupDn(org, id), [], additional, req);
    const group = await this.readGroup(org, id);
    res.status(201).json(group);
  }

  private async updateRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const body = bodyOf(req);
    const id = req.params.groupId as string;
    const unsupported = Object.keys(body).filter(
      k => !['name', 'description', 'color'].includes(k)
    );
    if (unsupported.length)
      throw invalid(
        `Only "name", "description" and "color" can be updated; unsupported field(s): ${unsupported.join(', ')}`
      );
    const { name, description, color } = body;
    if (name === undefined && description === undefined && color === undefined)
      throw invalid(
        'at least one of "name", "description" or "color" must be provided'
      );
    if (name !== undefined && !isDisplayName(name)) throw invalid(NAME_RULE);
    if (description !== undefined && typeof description !== 'string')
      throw invalid('description must be a string');
    if (color !== undefined && color !== '' && !isColor(color))
      throw invalid(
        'color must be a hex code (e.g. #RRGGBB or #RGB) or empty to clear it'
      );
    const replace: AttributesList = {};
    if (name !== undefined) {
      const holder = await this.named(org, name);
      if (holder && holder !== id)
        throw new RouteError(409, 'Group already exists', 'GROUP_EXISTS');
      replace[this.displayName] = name;
    }
    // An empty value clears the attribute.
    if (description !== undefined)
      replace.description = description ? description : [];
    if (color !== undefined) replace[this.color] = color ? color : [];
    await this.onGroup(() =>
      this.modifyGroup(this.groupDn(org, id), { replace }, req)
    );
    res.json({ success: true });
  }

  private async membersRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const p = this.page(req, MEMBER_SORT);
    const id = req.params.groupId as string;
    const group = await this.readGroup(org, id);
    if (!group) throw notFound('group');
    res.json({
      organizationId: org,
      id,
      ...(await this.memberPage(p, org, group.members as string[])),
    });
  }

  /**
   * A page of members' public profiles, each with what `extra` adds for its
   * username.
   */
  async memberPage(
    p: Page,
    org: string,
    names: string[],
    extra: (username: string) => Record<string, unknown> = () => ({}),
    req?: Request
  ): Promise<{
    members: Record<string, unknown>[];
    pagination: Record<string, number | boolean>;
  }> {
    const usernames = [
      ...new Map(names.map(u => [u.toLowerCase(), u])).values(),
    ];
    const profiles = await this.profiles(org, usernames, req);
    let members = usernames.map(u => ({
      ...(profiles.get(u.toLowerCase()) ?? { uid: u }),
      ...extra(u),
    }));
    if (p.search) {
      const needle = p.search.toLowerCase();
      members = members.filter(m =>
        [m.uid, m.displayName || m.cn, m.mail].some(v =>
          text(v).toLowerCase().includes(needle)
        )
      );
    }
    members = this.sorted(members, p.sortBy ?? 'uid', p.desc);
    const totalPages = Math.ceil(members.length / p.limit);
    return {
      members: members.slice(p.offset, p.offset + p.limit),
      pagination: {
        page: p.page,
        limit: p.limit,
        total: members.length,
        totalPages,
        hasNextPage: p.page < totalPages,
        hasPreviousPage: p.page > 1,
      },
    };
  }

  /**
   * Users of the organization by name, read in pages of the size limit. A
   * tombstone is no user: it cannot be added, as it would join hidden.
   */
  async users(
    org: string,
    usernames: string[],
    attributes: string[],
    req?: Request
  ): Promise<AttributesList[]> {
    const { deleted, deletedValue } = this.attrs;
    const live = deleted
      ? `(!(${deleted}=${escapeLdapFilter(deletedValue)}))`
      : '';
    const out: AttributesList[] = [];
    for (let i = 0; i < usernames.length; i += this.maxPage) {
      const chunk = usernames.slice(i, i + this.maxPage);
      const filter = `(&(|${chunk
        .map(u => `(${this.userAttribute}=${escapeLdapFilter(u)})`)
        .join('')})${live})`;
      try {
        const { searchEntries } = (await this.ldap.search(
          { paged: false, scope: 'one', filter, attributes },
          this.userBaseOf(org),
          req
        )) as SearchResult;
        out.push(...searchEntries);
      } catch (err) {
        if (extractLdapCode(err) !== 32) throw err;
      }
    }
    return out;
  }

  async profiles(
    org: string,
    usernames: string[],
    req?: Request
  ): Promise<Map<string, Record<string, unknown>>> {
    const attributes = [
      ...new Set([
        ...Object.values(this.memberFields),
        ...Object.values(NAME_FIELDS),
        TECHNICAL,
      ]),
    ];
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of await this.users(org, usernames, attributes, req)) {
      const name = read(entry, this.userAttribute);
      if (!name) continue;
      const profile: Record<string, unknown> = {};
      for (const [field, attribute] of Object.entries(this.memberFields)) {
        const value = read(entry, attribute);
        if (value !== undefined) profile[field] = value;
      }
      const fullName: Record<string, string> = {};
      for (const [field, attribute] of Object.entries(NAME_FIELDS)) {
        const value = read(entry, attribute);
        if (value !== undefined) fullName[field] = value;
      }
      if (Object.keys(fullName).length) profile.name = fullName;
      profile.isTechnical = read(entry, TECHNICAL)?.toUpperCase() === 'TRUE';
      byName.set(name.toLowerCase(), profile);
    }
    return byName;
  }

  private async addMembersRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const { usernames } = bodyOf(req);
    if (!Array.isArray(usernames) || usernames.length === 0)
      throw invalid('usernames must be a non-empty array');
    if (!usernames.every(u => typeof u === 'string' && u.length > 0))
      throw invalid('usernames must be an array of non-empty strings');
    if (usernames.length > this.maxPage)
      throw invalid(
        `usernames cannot exceed ${this.maxPage} entries per request`
      );
    const id = req.params.groupId as string;
    const group = await this.readGroup(org, id);
    if (!group) throw notFound('group');
    const wanted = [
      ...new Map((usernames as string[]).map(u => [u.toLowerCase(), u])).keys(),
    ];
    const found = new Map(
      (await this.users(org, wanted, [this.userAttribute])).map(e => {
        const name = read(e, this.userAttribute) || '';
        return [name.toLowerCase(), name];
      })
    );
    if (wanted.some(u => !found.has(u))) throw notFound('user');
    const held = new Set((group.members as string[]).map(u => u.toLowerCase()));
    const added = wanted
      .filter(u => !held.has(u))
      .map(u => this.userDn(org, found.get(u)!));
    const dn = this.groupDn(org, id);
    if (added.length) {
      await this.onGroup(() =>
        this.ldap.modify(dn, { add: { member: added } }, req)
      );
      await this.dropPlaceholder(dn, req);
    }
    res.json({ success: true });
  }

  private async dropPlaceholder(dn: string, req: Request): Promise<void> {
    const placeholder = this.config.group_dummy_user;
    if (!placeholder) return;
    try {
      await this.ldap.modify(dn, { delete: { member: placeholder } }, req);
    } catch (err) {
      // Not there, or the last member left
      if (![16, 65].includes(extractLdapCode(err) ?? 0)) throw err;
    }
  }

  private async removeMemberRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const dn = this.groupDn(org, req.params.groupId as string);
    const member = this.userDn(org, req.params.userId as string);
    try {
      await this.ldap.modify(dn, { delete: { member } }, req);
    } catch (err) {
      const code = extractLdapCode(err);
      if (code === 32) throw notFound('group');
      if (code === 16) throw notFound('member');
      if (code !== 65 || !this.config.group_dummy_user) throw err;
      // The last member: groupOfNames needs one, so the placeholder takes its seat.
      await this.ldap.modify(
        dn,
        { replace: { member: [this.config.group_dummy_user] } },
        req
      );
    }
    res.json({ success: true });
  }
}
