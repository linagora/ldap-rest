/**
 * @module plugins/twake/spaces
 *
 * Organization spaces: users and groups of an organization working together,
 * each with a role in the space.
 *
 * See `docs/usage/plugins/integrations/spaces.md`.
 */
import { randomUUID } from 'node:crypto';

import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import { BadRequestError } from '../../lib/errors';
import { extractLdapCode } from '../../lib/ldapCodes';
import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import { escapeDnValue, escapeLdapFilter } from '../../lib/utils';

import type TwakeGroups from './groups';
import {
  bodyOf,
  branchPattern,
  dnKey,
  invalid,
  isDisplayName,
  NAME_RULE,
  notFound,
  ORG,
  organizationIn,
  parentOf,
  rdnValue,
  read,
  RouteError,
  values,
} from './groups';
import { valueOf } from './lifecycleAttributes';

/** From the weakest to the strongest. */
export const SPACE_ROLES = ['viewer', 'editor', 'admin'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

const isRole = (role: unknown): role is SpaceRole =>
  SPACE_ROLES.includes(role as SpaceRole);

const BY_STRENGTH = [...SPACE_ROLES].reverse();

const SPACE_SORT = ['name'];
const MEMBER_SORT = ['uid', 'displayName', 'mail', 'jobTitle', 'role'];

type Kind = 'member' | 'group';

/** A user (`member`) or group of a space: its RDN value, role and DN. */
interface Holder {
  kind: Kind;
  name: string;
  role: SpaceRole;
  dn: string;
}

interface SpaceEntry {
  id: string;
  name: string;
  holders: Holder[];
}

export type Space = {
  id: string;
  name: string;
  organizationId: string;
  members: { username: string; role: SpaceRole }[];
  groups: { id: string; role: SpaceRole }[];
};

const conflict = (message: string, code: string): RouteError =>
  new RouteError(409, message, code);

const lastAdmin = (): RouteError =>
  conflict('A space keeps at least one admin', 'LAST_ADMIN');

const isAdmin = (h: Holder): boolean =>
  h.kind === 'member' && h.role === 'admin';

function roleOf(body: Record<string, unknown>): SpaceRole {
  if (!isRole(body.role))
    throw invalid(`role must be one of: ${SPACE_ROLES.join(', ')}`);
  return body.role;
}

function checkLength(list: unknown[], field: string, max: number): void {
  if (list.length > max)
    throw invalid(`${field} cannot exceed ${max} entries per request`);
}

/** A non-empty list of names, each spelled once whatever its case. */
function namesOf(list: unknown, field: string, max: number): string[] {
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every(v => typeof v === 'string' && v.length > 0)
  )
    throw invalid(`${field} must be a non-empty array of non-empty strings`);
  checkLength(list, field, max);
  return [
    ...new Map((list as string[]).map(v => [v.toLowerCase(), v])).values(),
  ];
}

function holdersOf(
  list: unknown,
  key: 'username' | 'id',
  max: number
): { name: string; role: SpaceRole }[] {
  const field = key === 'id' ? 'groups' : 'members';
  if (!Array.isArray(list))
    throw invalid(`${field} must be an array of { ${key}, role }`);
  checkLength(list, field, max);
  const seen = new Set<string>();
  return list.map((holder: unknown) => {
    const { [key]: name, role } = (holder ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name.length === 0 || !isRole(role))
      throw invalid(
        `${field} must be an array of { ${key}, role }, role one of: ${SPACE_ROLES.join(', ')}`
      );
    if (seen.has(name.toLowerCase()))
      throw invalid(`${name} is listed twice in ${field}`);
    seen.add(name.toLowerCase());
    return { name, role };
  });
}

export default class TwakeSpaces extends DmPlugin {
  name = 'twakeSpaces';
  roles: Role[] = ['api'];
  dependencies = { twakeGroups: 'core/twake/groups' };

  private readonly spaceBase: string;
  private readonly spacePattern: RegExp;
  private readonly displayName: string;
  readonly roleAttributes: Record<SpaceRole, string>;

  constructor(server: DM) {
    super(server);
    this.spaceBase = this.config.twake_space_base || '';
    if (!this.spaceBase.includes(ORG))
      throw new Error(`${this.name}: --twake-space-base must hold ${ORG}`);
    this.spacePattern = branchPattern(this.spaceBase);
    this.displayName =
      this.config.twake_space_display_name_attribute || 'twakeDisplayName';
    this.roleAttributes = {
      admin: this.config.twake_space_admin_attribute || 'twakeSpaceAdmin',
      editor: this.config.twake_space_editor_attribute || 'twakeSpaceEditor',
      viewer: this.config.twake_space_viewer_attribute || 'twakeSpaceViewer',
    };
  }

  private get groups(): TwakeGroups {
    return this.server.loadedPlugins.twakeGroups as unknown as TwakeGroups;
  }

  hooks: Hooks = {
    ldapaddrequest: ([dn, entry, req]) => {
      for (const attribute of Object.values(this.roleAttributes))
        this.checkHolders(dn, valueOf(entry, attribute));
      return [dn, entry, req];
    },
    ldapmodifyrequest: ([dn, changes, op, req]) => {
      for (const attribute of Object.values(this.roleAttributes))
        for (const set of [changes.add, changes.replace])
          if (set) this.checkHolders(dn, valueOf(set, attribute));
      return [dn, changes, op, req];
    },
  };

  /** The organization a space DN belongs to, if it is a space at all. */
  organizationOf(dn: string): string | undefined {
    return organizationIn(this.spacePattern, dn);
  }

  spaceBaseOf(org: string): string {
    return this.spaceBase.replace(ORG, escapeDnValue(org));
  }

  spaceDn(org: string, id: string): string {
    return `cn=${escapeDnValue(id)},${this.spaceBaseOf(org)}`;
  }

  /** A space holds users and groups of its organization, whichever API writes it. */
  private checkHolders(dn: string, held: AttributeValue | undefined): void {
    const org = this.organizationOf(dn);
    if (!org) return;
    const branches = [
      this.groups.userBaseOf(org),
      this.groups.groupBaseOf(org),
    ].map(dnKey);
    for (const holder of values(held))
      if (!branches.includes(dnKey(parentOf(holder))))
        throw new BadRequestError(
          `${holder} is neither a user nor a group of organization ${org}`
        );
  }

  api(app: Express): void {
    const base = `${this.config.api_prefix}/v1/organizations/:id/spaces`;
    const route = (
      context: string,
      handler: (req: Request, res: Response, org: string) => Promise<void>
    ): ((req: Request, res: Response) => Promise<void>) =>
      this.groups.organizationRoute(context, handler, this.name);
    const done = (res: Response): void => {
      res.json({ success: true });
    };
    const spaceId = (req: Request): string => req.params.spaceId as string;
    app.get(
      base,
      route('listing spaces', (q, r, o) => this.listRoute(q, r, o))
    );
    app.post(
      base,
      route('creating space', (q, r, o) => this.createRoute(q, r, o))
    );
    app.get(
      `${base}/:spaceId`,
      route('getting space', async (req, res, org) => {
        res.json(this.spaceOf(org, await this.space(org, spaceId(req))));
      })
    );
    app.patch(
      `${base}/:spaceId`,
      route('renaming space', async (req, res, org) => {
        const body = bodyOf(req);
        const unsupported = Object.keys(body).filter(k => k !== 'name');
        if (unsupported.length)
          throw invalid(
            `Only "name" can be updated; unsupported field(s): ${unsupported.join(', ')}`
          );
        if (!isDisplayName(body.name)) throw invalid(NAME_RULE);
        await this.write(
          org,
          spaceId(req),
          { replace: { [this.displayName]: body.name } },
          req
        );
        done(res);
      })
    );
    app.delete(
      `${base}/:spaceId`,
      route('deleting space', async (req, res, org) => {
        try {
          await this.server.ldap.delete(this.spaceDn(org, spaceId(req)), req);
        } catch (err) {
          if (extractLdapCode(err) === 32) throw notFound('space');
          throw err;
        }
        done(res);
      })
    );
    app.get(
      `${base}/:spaceId/members`,
      route('listing space members', async (req, res, org) => {
        const p = this.groups.page(req, MEMBER_SORT);
        const space = await this.space(org, spaceId(req));
        const members = space.holders.filter(h => h.kind === 'member');
        const roles = new Map(members.map(m => [m.name.toLowerCase(), m.role]));
        res.json({
          organizationId: org,
          id: space.id,
          ...(await this.groups.memberPage(
            p,
            org,
            members.map(m => m.name),
            username => ({ role: roles.get(username.toLowerCase()) })
          )),
        });
      })
    );
    app.post(
      `${base}/:spaceId/members`,
      route('adding space members', async (req, res, org) => {
        const body = bodyOf(req);
        const usernames = namesOf(
          body.usernames,
          'usernames',
          this.groups.maxPage
        );
        await this.add(req, org, 'member', roleOf(body), () =>
          this.liveUsers(org, usernames)
        );
        done(res);
      })
    );
    app.patch(
      `${base}/:spaceId/members/:userId`,
      route('changing space member role', async (req, res, org) => {
        await this.change(req, org, 'member', roleOf(bodyOf(req)));
        done(res);
      })
    );
    app.delete(
      `${base}/:spaceId/members/:userId`,
      route('removing space member', async (req, res, org) => {
        await this.change(req, org, 'member');
        done(res);
      })
    );
    app.get(
      `${base}/:spaceId/groups`,
      route('listing space groups', async (req, res, org) => {
        const space = await this.space(org, spaceId(req));
        const linked = space.holders.filter(h => h.kind === 'group');
        const names = new Map(
          (
            await this.orgGroups(
              org,
              linked.map(g => g.name)
            )
          ).map(e => [
            dnKey(e.dn as string),
            this.groups.groupOf(org, e).displayName as string,
          ])
        );
        const groups = linked
          .map(({ name: id, role, dn }) => ({
            id,
            name: names.get(dnKey(dn)) ?? id,
            role,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ organizationId: org, id: space.id, groups });
      })
    );
    app.post(
      `${base}/:spaceId/groups`,
      route('linking space groups', async (req, res, org) => {
        const body = bodyOf(req);
        const ids = namesOf(body.groupIds, 'groupIds', this.groups.maxPage);
        await this.add(req, org, 'group', roleOf(body), () =>
          this.groupDns(org, ids)
        );
        done(res);
      })
    );
    app.patch(
      `${base}/:spaceId/groups/:groupId`,
      route('changing space group role', async (req, res, org) => {
        await this.change(req, org, 'group', roleOf(bodyOf(req)));
        done(res);
      })
    );
    app.delete(
      `${base}/:spaceId/groups/:groupId`,
      route('unlinking space group', async (req, res, org) => {
        await this.change(req, org, 'group');
        done(res);
      })
    );
  }

  /** A space as the routes answer it, strongest role first. */
  private spaceOf(org: string, space: SpaceEntry): Space {
    return {
      id: space.id,
      name: space.name,
      organizationId: org,
      members: space.holders
        .filter(h => h.kind === 'member')
        .map(({ name, role }) => ({ username: name, role })),
      groups: space.holders
        .filter(h => h.kind === 'group')
        .map(({ name, role }) => ({ id: name, role })),
    };
  }

  /**
   * The users and groups an entry holds, strongest role first, each once
   * with its strongest role. A tombstone is hidden.
   */
  private entryOf(
    org: string,
    entry: AttributesList,
    hidden: Set<string>
  ): SpaceEntry {
    const kinds = new Map<string, Kind>([
      [dnKey(this.groups.userBaseOf(org)), 'member'],
      [dnKey(this.groups.groupBaseOf(org)), 'group'],
    ]);
    const id = read(entry, 'cn') || '';
    const seen = new Set<string>();
    const holders: Holder[] = [];
    for (const role of BY_STRENGTH)
      for (const dn of values(valueOf(entry, this.roleAttributes[role]))) {
        const key = dnKey(dn);
        const kind = kinds.get(dnKey(parentOf(dn)));
        if (!kind || seen.has(key) || hidden.has(key)) continue;
        seen.add(key);
        holders.push({ kind, name: rdnValue(dn), role, dn });
      }
    return { id, name: read(entry, this.displayName) ?? id, holders };
  }

  /** The spaces of the organization matching a filter, or the one of an id. */
  private async spaces(
    org: string,
    filter: string,
    id?: string
  ): Promise<SpaceEntry[]> {
    const search = async (): Promise<AttributesList[]> => {
      try {
        return (
          (await this.server.ldap.search(
            {
              paged: false,
              scope: id === undefined ? 'one' : 'base',
              filter,
              attributes: [
                'cn',
                this.displayName,
                ...Object.values(this.roleAttributes),
              ],
            },
            id === undefined ? this.spaceBaseOf(org) : this.spaceDn(org, id)
          )) as SearchResult
        ).searchEntries;
      } catch (err) {
        if (extractLdapCode(err) === 32) return [];
        throw err;
      }
    };
    const [entries, tombstones] = await Promise.all([
      search(),
      this.groups.tombstonesOf(org),
    ]);
    const hidden = new Set(tombstones.map(dnKey));
    return entries.map(e => this.entryOf(org, e, hidden));
  }

  private async space(org: string, id: string): Promise<SpaceEntry> {
    const [space] = await this.spaces(org, '(objectClass=*)', id);
    if (!space) throw notFound('space');
    return space;
  }

  private async write(
    org: string,
    id: string,
    changes: ModifyRequest,
    req: Request
  ): Promise<void> {
    try {
      await this.server.ldap.modify(this.spaceDn(org, id), changes, req);
    } catch (err) {
      if (extractLdapCode(err) === 32) throw notFound('space');
      throw err;
    }
  }

  /** The live users of the organization by lowercased name, as DNs, or a 404. */
  private async liveUsers(
    org: string,
    usernames: string[]
  ): Promise<Map<string, string>> {
    const attribute = this.groups.userAttribute;
    const found = new Map(
      (await this.groups.users(org, usernames, [attribute])).map(e => [
        (read(e, attribute) || '').toLowerCase(),
        e.dn as string,
      ])
    );
    if (usernames.some(u => !found.has(u.toLowerCase())))
      throw notFound('user');
    return found;
  }

  private async orgGroups(
    org: string,
    ids: string[]
  ): Promise<AttributesList[]> {
    if (ids.length === 0) return [];
    const cn = this.groups.cn;
    return this.groups.groups(
      org,
      `(|${ids.map(id => `(${cn}=${escapeLdapFilter(id)})`).join('')})`,
      [cn, this.config.twake_group_display_name_attribute || 'twakeDisplayName']
    );
  }

  /** The groups of the organization by lowercased id, as DNs, or a 404. */
  private async groupDns(
    org: string,
    ids: string[]
  ): Promise<Map<string, string>> {
    const found = new Map(
      (await this.orgGroups(org, ids)).map(e => [
        (read(e, this.groups.cn) || '').toLowerCase(),
        e.dn as string,
      ])
    );
    if (ids.some(id => !found.has(id.toLowerCase()))) throw notFound('group');
    return found;
  }

  /** Each of a space's members or groups holds one role. */
  private async add(
    req: Request,
    org: string,
    kind: Kind,
    role: SpaceRole,
    resolve: () => Promise<Map<string, string>>
  ): Promise<void> {
    const space = await this.space(org, req.params.spaceId as string);
    const found = await resolve();
    const held = new Map(
      space.holders
        .filter(h => h.kind === kind)
        .map(h => [h.name.toLowerCase(), h.role])
    );
    const added: string[] = [];
    for (const [name, dn] of found) {
      const current = held.get(name);
      if (current === undefined) added.push(dn);
      else if (current !== role)
        throw kind === 'member'
          ? conflict(
              `${name} is already a member, as ${current}`,
              'MEMBER_EXISTS'
            )
          : conflict(
              `${name} is already linked, as ${current}`,
              'GROUP_ALREADY_LINKED'
            );
    }
    if (added.length)
      await this.write(
        org,
        space.id,
        { add: { [this.roleAttributes[role]]: added } },
        req
      );
  }

  /**
   * Move a member or group to another role, or out of the space without
   * one. A space keeps at least one admin among its users.
   */
  private async change(
    req: Request,
    org: string,
    kind: Kind,
    role?: SpaceRole
  ): Promise<void> {
    const space = await this.space(org, req.params.spaceId as string);
    const name = (
      kind === 'member' ? req.params.userId : req.params.groupId
    ) as string;
    const held = space.holders.find(
      h => h.kind === kind && h.name.toLowerCase() === name.toLowerCase()
    );
    if (!held) throw notFound(kind);
    if (held.role === role) return;
    const demoted = kind === 'member' && held.role === 'admin';
    if (demoted && !space.holders.some(h => h !== held && isAdmin(h)))
      throw lastAdmin();
    const from = { [this.roleAttributes[held.role]]: held.dn };
    const to = role ? { [this.roleAttributes[role]]: held.dn } : undefined;
    await this.write(org, space.id, { delete: from, add: to }, req);
    // Two admins removed at once both pass the check above: the one that
    // finds no admin left takes its change back.
    if (demoted && !(await this.space(org, space.id)).holders.some(isAdmin)) {
      await this.write(org, space.id, { add: from, delete: to }, req);
      throw lastAdmin();
    }
  }

  private async listRoute(
    req: Request,
    res: Response,
    org: string
  ): Promise<void> {
    const p = this.groups.page(req, SPACE_SORT);
    let filter = '(cn=*)';
    if (p.search)
      filter = `(&${filter}(${this.displayName}=*${escapeLdapFilter(p.search)}*))`;
    const user = req.query.user;
    let roleIn: ((space: SpaceEntry) => SpaceRole | undefined) | undefined;
    if (user !== undefined) {
      if (typeof user !== 'string' || !user)
        throw invalid('user must be a username');
      const [dn] = (await this.liveUsers(org, [user])).values();
      const groups = (
        await this.groups.groups(org, `(member=${escapeLdapFilter(dn)})`, [
          this.groups.cn,
        ])
      ).map(e => dnKey(e.dn as string));
      const holders = [dn, ...groups]
        .flatMap(holder =>
          Object.values(this.roleAttributes).map(
            a => `(${a}=${escapeLdapFilter(holder)})`
          )
        )
        .join('');
      filter = `(&${filter}(|${holders}))`;
      const own = new Set([dnKey(dn), ...groups]);
      roleIn = (space: SpaceEntry): SpaceRole | undefined =>
        space.holders.find(h => own.has(dnKey(h.dn)))?.role;
    }
    const spaces = this.groups.sorted(
      (await this.spaces(org, filter)).map(s => ({
        ...this.spaceOf(org, s),
        ...(roleIn && { role: roleIn(s) }),
      })),
      p.sortBy,
      p.desc
    );
    res.json({
      organizationId: org,
      spaces: spaces.slice(p.offset, p.offset + p.limit),
      pagination: {
        page: p.page,
        limit: p.limit,
        total: spaces.length,
        totalPages: Math.ceil(spaces.length / p.limit),
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
    const max = this.groups.maxPage;
    const members = holdersOf(body.members, 'username', max);
    const groups = holdersOf(body.groups ?? [], 'id', max);
    if (!members.some(m => m.role === 'admin'))
      throw invalid(
        'A space needs an admin among its members',
        'ADMIN_REQUIRED'
      );
    const [users, groupDns] = await Promise.all([
      this.liveUsers(
        org,
        members.map(m => m.name)
      ),
      this.groupDns(
        org,
        groups.map(g => g.name)
      ),
    ]);
    const id = randomUUID();
    const entry: AttributesList = {
      objectClass: this.config.twake_space_class || ['top', 'twakeSpace'],
      cn: id,
      [this.displayName]: body.name,
    };
    for (const [holders, dns] of [
      [members, users],
      [groups, groupDns],
    ] as const)
      for (const { name, role } of holders) {
        const attribute = this.roleAttributes[role];
        entry[attribute] = [
          ...values(entry[attribute]),
          dns.get(name.toLowerCase())!,
        ];
      }
    await this.server.ldap.add(this.spaceDn(org, id), entry, req);
    res.status(201).json(this.spaceOf(org, await this.space(org, id)));
  }
}
