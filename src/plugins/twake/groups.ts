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

import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import { BadRequestError, HttpError } from '../../lib/errors';
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
  normalizeDn,
  parseDn,
  unescapeDnValue,
} from '../../lib/utils';
import LdapGroups from '../ldap/groups';

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
const read = (entry: AttributesList, attribute: string): string | undefined =>
  first(valueOf(entry, attribute));

const ORG = '{org}';

const GROUP_SORT = ['displayName', 'description', 'createdAt'];
const NOT_FOUND = {
  organization: 'Organization not found',
  group: 'Group not found',
  user: 'User not found',
  member: 'Member not found',
};

/** A refusal the routes answer as `{ error, code }`. */
class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

const notFound = (what: keyof typeof NOT_FOUND): RouteError =>
  new RouteError(404, NOT_FOUND[what], `${what.toUpperCase()}_NOT_FOUND`);
const invalid = (message: string, code = 'INVALID_INPUT'): RouteError =>
  new RouteError(400, message, code);

const NAME_RULE =
  'name must be a non-blank string of at most 256 characters with no control characters';

function isDisplayName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 256 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(name)
  );
}

const isColor = (color: unknown): color is string =>
  typeof color === 'string' &&
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** A request without a JSON object body leaves `req.body` undefined. */
function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw invalid('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

interface Page {
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
function dnKey(dn: string): string {
  try {
    return normalizeDn(dn);
  } catch {
    return dn.toLowerCase();
  }
}

function parentOf(dn: string): string {
  return parseDn(dn).slice(1).join(',');
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
  private readonly maxPage: number;

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
    // The organization is one RDN value: `(?:\\.|[^,])+` keeps an escaped
    // comma inside it.
    const [before, after] = parseDn(this.groupBase)
      .join(',')
      .split(ORG)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.groupPattern = new RegExp(
      `^${before}(?<org>(?:\\\\.|[^,])+)${after}$`,
      'i'
    );
    this.attrs = lifecycleAttributes(this.config);
    this.orgPattern = this.config.twake_group_organization_dn || '';
    this.displayName =
      this.config.twake_group_display_name_attribute || 'twakeDisplayName';
    this.color = this.config.twake_group_color_attribute || 'twakeGroupColor';
    this.createdAt =
      this.config.twake_group_created_at_attribute || 'twakeCreatedAt';
    this.maxPage = this.config.twake_group_max_page_limit || 1000;
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
      return [dn, entry, req];
    },
    ldapmodifyrequest: ([dn, changes, op, req]) => {
      this.checkMembers(dn, changes.add?.member);
      this.checkMembers(dn, changes.replace?.member);
      return [dn, changes, op, req];
    },
    ldapsearchfilter: async ([result, req, opts]) => [
      await this.hideTombstones(result),
      req,
      opts,
    ],
  };

  /** The organization a group DN belongs to, if it is a group at all. */
  organizationOf(dn: string): string | undefined {
    const spelled = parseDn(dn).join(',');
    const m = this.groupPattern.exec(parentOf(spelled));
    return m?.groups ? unescapeDnValue(m.groups.org) : undefined;
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
    const users = dnKey(this.userBaseOf(org));
    for (const member of values(members)) {
      if (isDummyMemberDn(member, this.config.group_dummy_user)) continue;
      if (dnKey(parentOf(member)) !== users)
        throw new BadRequestError(
          `${member} is not a user of organization ${org}`
        );
    }
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

  private async tombstonesOf(org: string): Promise<string[]> {
    const { deleted, deletedValue } = this.attrs;
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
    const route =
      (
        context: string,
        handler: (req: Request, res: Response, org: string) => Promise<void>
      ) =>
      async (req: Request, res: Response): Promise<void> => {
        try {
          const org = req.params.id as string;
          await this.checkOrganization(org);
          await handler(req, res, org);
        } catch (err) {
          if (err instanceof RouteError) {
            res.status(err.status).json({ error: err.message, code: err.code });
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
          this.logger.error({ plugin: this.name, context, error: String(err) });
          res
            .status(500)
            .json({ error: `Error ${context}`, code: 'INTERNAL_ERROR' });
        }
      };
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
  }

  private groupDn(org: string, id: string): string {
    return `${this.cn}=${escapeDnValue(id)},${this.groupBaseOf(org)}`;
  }

  /** Every route answers 404 for a missing organization, 410 for a deleted one. */
  private async checkOrganization(org: string): Promise<void> {
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
  private page(req: Request, sortable: string[]): Page {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(
      1,
      Math.min(parseInt(req.query.limit as string) || 20, this.maxPage)
    );
    const search = req.query.search as string | undefined;
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

  private sorted<T extends Record<string, unknown>>(
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
  private groupOf(org: string, entry: AttributesList): Record<string, unknown> {
    const cn = read(entry, this.cn) || '';
    const users = dnKey(this.userBaseOf(org));
    const members = values(entry.member)
      .filter(m => !isDummyMemberDn(m, this.config.group_dummy_user))
      .map(m => {
        const [rdn] = parseDn(m);
        const eq = rdn.indexOf('=');
        return dnKey(parentOf(m)) === users && eq > 0
          ? unescapeDnValue(rdn.slice(eq + 1).trim())
          : m;
      });
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

  private async groups(org: string, filter: string): Promise<AttributesList[]> {
    try {
      const { searchEntries } = (await this.ldap.search(
        { paged: false, scope: 'one', filter },
        this.groupBaseOf(org)
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
      filter = `(&${filter}(|(${this.displayName}=*${s}*)(description=*${s}*)))`;
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
}
