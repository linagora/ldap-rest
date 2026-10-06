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
import type { ChangeContext } from '../../lib/changeContext';
import { BadRequestError } from '../../lib/errors';
import { extractLdapCode } from '../../lib/ldapCodes';
import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import { currentOperation } from '../../lib/operation';
import { escapeDnValue, escapeLdapFilter, parseDn } from '../../lib/utils';
import type RabbitMq from '../rabbitmq';

import type TwakeGroups from './groups';
import type TwakeTombstone from './tombstone';
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
import {
  isTombstone,
  lifecycleAttributes,
  type LifecycleAttributes,
  valueOf,
} from './lifecycleAttributes';

/** From the weakest to the strongest. */
export const SPACE_ROLES = ['viewer', 'editor', 'admin'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

const isRole = (role: unknown): role is SpaceRole =>
  SPACE_ROLES.includes(role as SpaceRole);

const BY_STRENGTH = [...SPACE_ROLES].reverse();

const SPACE_SORT = ['name'];
const MEMBER_SORT = ['uid', 'displayName', 'mail', 'jobTitle', 'role'];

type Kind = 'member' | 'group';

/**
 * A user (`member`) or group of a space: its RDN value, strongest role and
 * DN, and every role it is held under.
 */
interface Holder {
  kind: Kind;
  name: string;
  role: SpaceRole;
  roles: SpaceRole[];
  dn: string;
}

interface SpaceEntry {
  id: string;
  name: string;
  holders: Holder[];
}

/** A user role value; the values of another form are not the plugin's. */
const ROLE_VALUE = new RegExp(`:(${SPACE_ROLES.join('|')})$`, 'i');

/** Each user's role, by space id. */
type Roles = Map<string, SpaceRole>;

/** A user whose roles a change may have moved. */
interface Moved {
  dn: string;
  before: Roles;
  after: Roles;
}

/**
 * The directory as it was before a change, for the roles it gave: a space
 * as it was (none when created), or a group's members as they were, with
 * the spaces a deleted group was in.
 */
type Undo =
  | { id: string; space?: SpaceEntry }
  | {
      group: string;
      members: Set<string>;
      spaces?: { id: string; role: SpaceRole }[];
    };

interface DeletedGroup {
  org: string;
  id: string;
  name: string;
  spaces: { id: string; role: SpaceRole }[];
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
  dependencies: Record<string, string> = {
    twakeGroups: 'core/twake/groups',
    onLdapChange: 'core/ldap/onChange',
  };

  private readonly spaceBase: string;
  private readonly spacePattern: RegExp;
  private readonly userPattern: RegExp;
  private readonly lifecycle: LifecycleAttributes;
  private readonly displayName: string;
  readonly roleAttributes: Record<SpaceRole, string>;
  private readonly userRole: string;
  private readonly exchange: string;
  /**
   * Changes are followed one at a time, each from the directory as it is
   * then, so the order they are followed in does not matter.
   */
  private following: Promise<void> = Promise.resolve();
  private publishing: Promise<void> = Promise.resolve();
  /**
   * The spaces of a group being deleted, by DN key, read before refint takes
   * it out of them, until its deletion is followed. `op` is the delete
   * still running.
   */
  private readonly unlinking = new Map<
    string,
    DeletedGroup & { op?: number }
  >();
  /**
   * The spaces a user being deleted is an admin of, by operation and DN,
   * read before refint takes the user out of them.
   */
  private readonly handing = new Map<
    number,
    Map<string, { org: string; ids: string[] }>
  >();

  constructor(server: DM) {
    super(server);
    this.spaceBase = this.config.twake_space_base || '';
    if (!this.spaceBase.includes(ORG))
      throw new Error(`${this.name}: --twake-space-base must hold ${ORG}`);
    this.spacePattern = branchPattern(this.spaceBase);
    this.userPattern = branchPattern(this.config.twake_group_user_base!);
    this.lifecycle = lifecycleAttributes(this.config);
    this.displayName =
      this.config.twake_space_display_name_attribute || 'twakeDisplayName';
    this.roleAttributes = {
      admin: this.config.twake_space_admin_attribute || 'twakeSpaceAdmin',
      editor: this.config.twake_space_editor_attribute || 'twakeSpaceEditor',
      viewer: this.config.twake_space_viewer_attribute || 'twakeSpaceViewer',
    };
    this.userRole = this.config.twake_space_user_role_attribute || '';
    this.exchange = this.config.twake_space_exchange || 'space';
    if (this.config.rabbitmq_url) this.dependencies.rabbitmq = 'core/rabbitmq';
  }

  /** Whether user roles are kept or events published. */
  private get follows(): boolean {
    return Boolean(this.userRole || this.config.rabbitmq_url);
  }

  private get groups(): TwakeGroups {
    return this.server.loadedPlugins.twakeGroups as unknown as TwakeGroups;
  }

  private get tombstone(): TwakeTombstone | undefined {
    return this.server.loadedPlugins.twakeTombstone as unknown as
      | TwakeTombstone
      | undefined;
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
    ldapdeleterequest: async ([dn, req]) => {
      const op = currentOperation();
      if (op !== undefined)
        for (const one of [dn].flat()) {
          const org = organizationIn(this.userPattern, one);
          if (org !== undefined) {
            // A delete core/twake/tombstone turns into a tombstone is handed
            // over when the tombstone is followed; the erase of one, here.
            if (this.tombstone?.keeps(one)) continue;
            const ids = await this.administered(org, one);
            if (!ids.length) continue;
            if (!this.handing.has(op)) this.handing.set(op, new Map());
            this.handing.get(op)!.set(dnKey(one), { org, ids });
          } else if (this.rabbitmq) {
            const deleted = await this.deletedGroup(one);
            if (deleted) this.unlinking.set(dnKey(one), { ...deleted, op });
          }
        }
      return [dn, req];
    },
    ldapdeletedone: (dn, context = {}) => {
      const op = currentOperation();
      const handing = op === undefined ? undefined : this.handing.get(op);
      for (const one of [dn].flat()) {
        const deleted = this.unlinking.get(dnKey(one));
        if (deleted) delete deleted.op;
        const admin = handing?.get(dnKey(one));
        if (admin)
          this.queue(one, () =>
            this.handOver(admin.org, one, admin.ids, context)
          );
      }
    },
    ldapdeleteend: op => {
      this.handing.delete(op);
      for (const [key, deleted] of this.unlinking)
        if (deleted.op === op) this.unlinking.delete(key);
    },
    onLdapEntryChange: (dn, before, after, context) => {
      if (this.follows)
        this.queue(dn, () =>
          this.follow(
            dn,
            before as AttributesList | null,
            after as AttributesList | null,
            context
          )
        );
      const org = organizationIn(this.userPattern, dn);
      if (
        org !== undefined &&
        this.lifecycle.deleted &&
        before &&
        after &&
        !isTombstone(before as AttributesList, this.lifecycle) &&
        isTombstone(after as AttributesList, this.lifecycle)
      )
        this.queue(dn, async () =>
          this.handOver(org, dn, await this.administered(org, dn), context)
        );
    },
  };

  /**
   * core/rabbitmq connects lazily and hands back no client when it cannot:
   * every event would then be lost, so the server does not start.
   *
   * core/ldap/trash moves a deleted group or space away instead of deleting
   * it: nothing follows the move, and users would keep the roles it gave.
   */
  async assertComposition(): Promise<void> {
    if (this.config.rabbitmq_url && !(await this.rabbitmq?.getRawClient()))
      throw new Error(
        `${this.name}: RabbitMQ at --rabbitmq-url cannot be reached`
      );
    if (!this.userRole || !this.server.loadedPlugins.trash) return;
    const type = (rdn: string): string => rdn.split('=')[0].toLowerCase();
    // A watched base above a branch, or in one, holds its entries
    const holds = (pattern: string) => {
      const branch = parseDn(pattern).reverse();
      return (base: string): boolean =>
        parseDn(base)
          .reverse()
          .slice(0, branch.length)
          .every((rdn, i) =>
            branch[i].includes(ORG)
              ? type(rdn) === type(branch[i])
              : dnKey(rdn) === dnKey(branch[i])
          );
    };
    const branches = [this.config.twake_group_base || '', this.spaceBase].map(
      holds
    );
    const watched = String(this.config.trash_watched_bases || '')
      .split(';')
      .map(base => base.trim())
      .filter(Boolean);
    if (
      watched.length === 0 ||
      watched.some(base => branches.some(held => held(base)))
    )
      throw new Error(
        `${this.name}: core/ldap/trash watches the organization groups or ` +
          `spaces, and users would keep the space roles of a deleted one. ` +
          `Leave the group and space branches out of --trash-watched-bases, ` +
          `or unset --twake-space-user-role-attribute`
      );
  }

  private queue(dn: string, task: () => Promise<void>): void {
    this.following = this.following.then(() =>
      task().catch((err: unknown) => {
        this.logger.error({
          plugin: this.name,
          event: 'follow',
          dn,
          error: String(err),
        });
      })
    );
  }

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
        res.json(this.spaceOf(org, await this.space(org, spaceId(req), req)));
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
        const space = await this.space(org, spaceId(req), req);
        const members = space.holders.filter(h => h.kind === 'member');
        const roles = new Map(members.map(m => [m.name.toLowerCase(), m.role]));
        res.json({
          organizationId: org,
          id: space.id,
          ...(await this.groups.memberPage(
            p,
            org,
            members.map(m => m.name),
            username => ({ role: roles.get(username.toLowerCase()) }),
            req
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
          this.liveUsers(org, usernames, req)
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
        const space = await this.space(org, spaceId(req), req);
        const linked = space.holders.filter(h => h.kind === 'group');
        const names = new Map(
          (
            await this.orgGroups(
              org,
              linked.map(g => g.name),
              [],
              req
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
          this.groupDns(org, ids, req)
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
    const seen = new Map<string, Holder>();
    for (const role of BY_STRENGTH)
      for (const dn of values(valueOf(entry, this.roleAttributes[role]))) {
        const key = dnKey(dn);
        const kind = kinds.get(dnKey(parentOf(dn)));
        if (!kind || hidden.has(key)) continue;
        const held = seen.get(key);
        if (held) held.roles.push(role);
        else
          seen.set(key, { kind, name: rdnValue(dn), role, roles: [role], dn });
      }
    return {
      id,
      name: read(entry, this.displayName) ?? id,
      holders: [...seen.values()],
    };
  }

  /** The spaces of the organization matching a filter, or the one of an id. */
  private async spaces(
    org: string,
    filter: string,
    id?: string,
    req?: Request
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
            id === undefined ? this.spaceBaseOf(org) : this.spaceDn(org, id),
            req
          )) as SearchResult
        ).searchEntries;
      } catch (err) {
        if (extractLdapCode(err) === 32) return [];
        throw err;
      }
    };
    const [entries, hidden] = await Promise.all([search(), this.hidden(org)]);
    return entries.map(e => this.entryOf(org, e, hidden));
  }

  /**
   * Whoever asks: a tombstone outside the caller's branches would otherwise
   * count as a member, and as an admin.
   */
  private async hidden(org: string): Promise<Set<string>> {
    return new Set((await this.groups.tombstonesOf(org)).map(dnKey));
  }

  /** A filter for the spaces holding any of these DNs, whatever the role. */
  private holding(dns: string[]): string {
    return `(|${dns
      .flatMap(dn =>
        Object.values(this.roleAttributes).map(
          a => `(${a}=${escapeLdapFilter(dn)})`
        )
      )
      .join('')})`;
  }

  private async space(
    org: string,
    id: string,
    req?: Request
  ): Promise<SpaceEntry> {
    const [space] = await this.spaces(org, '(objectClass=*)', id, req);
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

  /**
   * A change decided on a space read before another request wrote it fails
   * with LDAP 16 or 20: it is decided again on the space as it is now.
   */
  private async again(change: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await change();
      } catch (err) {
        const code = extractLdapCode(err);
        if ((code !== 16 && code !== 20) || attempt >= 2) throw err;
      }
    }
  }

  /** The live users of the organization by lowercased name, as DNs, or a 404. */
  private async liveUsers(
    org: string,
    usernames: string[],
    req?: Request
  ): Promise<Map<string, string>> {
    const attribute = this.groups.userAttribute;
    const found = new Map(
      (await this.groups.users(org, usernames, [attribute], req)).map(e => [
        (read(e, attribute) || '').toLowerCase(),
        e.dn as string,
      ])
    );
    if (usernames.some(u => !found.has(u.toLowerCase())))
      throw notFound('user');
    return found;
  }

  private get groupName(): string {
    return this.config.twake_group_display_name_attribute || 'twakeDisplayName';
  }

  /** Groups of the organization by id, read in pages of the size limit. */
  private async orgGroups(
    org: string,
    ids: string[],
    extra: string[] = [],
    req?: Request
  ): Promise<AttributesList[]> {
    const cn = this.groups.cn;
    const out: AttributesList[] = [];
    for (let i = 0; i < ids.length; i += this.groups.maxPage) {
      const chunk = ids.slice(i, i + this.groups.maxPage);
      out.push(
        ...(await this.groups.groups(
          org,
          `(|${chunk.map(id => `(${cn}=${escapeLdapFilter(id)})`).join('')})`,
          [cn, this.groupName, ...extra],
          req
        ))
      );
    }
    return out;
  }

  /**
   * The users a space write or a change of a group's members may have
   * moved, and the events of the write. A deleted group is followed through
   * its members as they were.
   */
  private async follow(
    dn: string,
    before: AttributesList | null,
    after: AttributesList | null,
    context: ChangeContext
  ): Promise<void> {
    let org = this.organizationOf(dn);
    if (org !== undefined) {
      const [was, is] = [before, after].map(e =>
        e ? this.entryOf(org!, e, new Set()) : undefined
      );
      const holders = [was, is].flatMap(s => s?.holders ?? []);
      const groups = new Set(
        holders.filter(h => h.kind === 'group').map(h => h.name)
      );
      const linked = await this.orgGroups(org, [...groups], ['member']);
      const moved = await this.settle(
        org,
        [
          ...holders.filter(h => h.kind === 'member').map(h => h.dn),
          ...linked.flatMap(e => values(e.member)),
        ],
        { id: (is ?? was)!.id, space: was }
      );
      if (this.rabbitmq)
        await this.announce(org, moved, context, { was, is, linked });
      return;
    }
    org = this.groups.organizationOf(dn);
    // A group just created is linked to no space yet
    if (org === undefined || !before) return;
    const was = values(before.member);
    const is = values(after?.member);
    const [wasKeys, isKeys] = [was, is].map(list => new Set(list.map(dnKey)));
    const deleted = after ? undefined : this.unlinking.get(dnKey(dn));
    if (deleted) this.unlinking.delete(dnKey(dn));
    const moved = await this.settle(
      org,
      [
        ...was.filter(m => !isKeys.has(dnKey(m))),
        ...is.filter(m => !wasKeys.has(dnKey(m))),
      ],
      { group: dn, members: wasKeys, spaces: deleted?.spaces }
    );
    if (!this.rabbitmq) return;
    if (deleted) this.unlinked(deleted, context);
    await this.announce(org, moved, context);
  }

  /**
   * The spaces a user is an admin of. Read again when a tombstone is erased:
   * its hand-over may have failed, or predate this plugin, and handing over
   * a space that keeps another admin does nothing.
   */
  private async administered(org: string, dn: string): Promise<string[]> {
    try {
      const filter = `(${this.roleAttributes.admin}=${escapeLdapFilter(dn)})`;
      return (await this.spaces(org, filter)).map(s => s.id);
    } catch (err) {
      // The hand-over is lost, the deletion goes on
      this.logger.error({
        plugin: this.name,
        event: 'handOver',
        dn,
        error: String(err),
      });
      return [];
    }
  }

  /**
   * A space a deleted user was the last admin of goes to its editors, else
   * its viewers; one left with no member is deleted.
   */
  private async handOver(
    org: string,
    dn: string,
    ids: string[],
    context: ChangeContext
  ): Promise<void> {
    for (const id of ids)
      try {
        await this.again(() => this.handOverOnce(org, dn, id, context));
      } catch (err) {
        this.logger.error({
          plugin: this.name,
          event: 'handOver',
          space: id,
          error: String(err),
        });
      }
  }

  private async handOverOnce(
    org: string,
    dn: string,
    id: string,
    context: ChangeContext
  ): Promise<void> {
    const key = dnKey(dn);
    const [space] = await this.spaces(org, '(objectClass=*)', id);
    // Linked groups do not count: a space has users of its own
    const members =
      space?.holders.filter(h => h.kind === 'member' && dnKey(h.dn) !== key) ??
      [];
    if (!space || members.some(h => h.role === 'admin')) return;
    if (!members.length) {
      await this.server.ldap.delete(this.spaceDn(org, id), undefined, {
        context,
      });
      return;
    }
    const role = members.some(h => h.role === 'editor') ? 'editor' : 'viewer';
    const promoted = members.filter(h => h.role === role).map(h => h.dn);
    await this.server.ldap.modify(
      this.spaceDn(org, id),
      {
        delete: { [this.roleAttributes[role]]: promoted },
        add: { [this.roleAttributes.admin]: promoted },
      },
      undefined,
      { context }
    );
  }

  /** A group about to be deleted, if it is one linked to spaces. */
  private async deletedGroup(dn: string): Promise<DeletedGroup | undefined> {
    const org = this.groups.organizationOf(dn);
    if (org === undefined) return undefined;
    try {
      const spaces = (await this.spaces(org, this.holding([dn]))).flatMap(s => {
        const held = s.holders.find(h => dnKey(h.dn) === dnKey(dn));
        return held ? [{ id: s.id, role: held.role }] : [];
      });
      if (!spaces.length) return undefined;
      const [group] = await this.orgGroups(org, [rdnValue(dn)]);
      const id = rdnValue(dn);
      return {
        org,
        id,
        name: (group && read(group, this.groupName)) || id,
        spaces,
      };
    } catch (err) {
      // The events of the group are lost, the deletion goes on
      this.logger.error({
        plugin: this.name,
        event: 'deleting',
        dn,
        error: String(err),
      });
      return undefined;
    }
  }

  /** The spaces a deleted group left. */
  private unlinked(deleted: DeletedGroup, context: ChangeContext): void {
    const { org, id: group, name, spaces } = deleted;
    for (const { id, role } of spaces)
      this.publishEvent(org, id, 'group.unlinked', context, {
        groups: [{ id: group, name, role }],
      });
  }

  /**
   * Rewrite each user's roles from the directory as it is now: a change
   * only tells which users to look at, so two changes followed in either
   * order, or late, leave the same roles.
   *
   * The roles each user had come from the values written before, or, with
   * no user role attribute, from the directory with the change undone: two
   * changes followed late may then announce a role twice, or not at all.
   */
  private async settle(
    org: string,
    dns: string[],
    undo: Undo
  ): Promise<Moved[]> {
    const users = dnKey(this.groups.userBaseOf(org));
    const hidden = await this.hidden(org);
    const todo = new Map(
      dns.filter(dn => dnKey(parentOf(dn)) === users).map(dn => [dnKey(dn), dn])
    );
    const moved: Moved[] = [];
    for (const [key, dn] of todo) {
      // A tombstone keeps the values it held
      if (hidden.has(key)) continue;
      try {
        const after = await this.rolesOf(org, dn);
        const before = this.userRole
          ? await this.writeRoles(dn, after)
          : await this.rolesOf(org, dn, undo);
        if (before) moved.push({ dn, before, after });
      } catch (err) {
        this.logger.error({
          plugin: this.name,
          event: 'settle',
          dn,
          error: String(err),
        });
      }
    }
    return moved;
  }

  /**
   * A filter for the spaces a user is in, directly or through a group, and
   * their role in one of them. With a group's members undone, as they were.
   */
  private async userIn(
    org: string,
    dn: string,
    req?: Request,
    undo?: Undo
  ): Promise<{
    filter: string;
    roleIn: (space: SpaceEntry) => SpaceRole | undefined;
  }> {
    const groups = (
      await this.groups.groups(
        org,
        `(member=${escapeLdapFilter(dn)})`,
        [this.groups.cn],
        req
      )
    ).map(e => dnKey(e.dn as string));
    const own = new Set([dnKey(dn), ...groups]);
    const holding = [dn, ...groups];
    if (undo && 'group' in undo) {
      const group = dnKey(undo.group);
      own.delete(group);
      if (undo.members.has(dnKey(dn))) own.add(group);
      holding.push(undo.group);
    }
    return {
      filter: this.holding(holding),
      roleIn: space => space.holders.find(h => own.has(dnKey(h.dn)))?.role,
    };
  }

  /**
   * The events of a followed change: the space write itself, then each
   * moved user's roles, except in a space created or deleted by it.
   */
  private async announce(
    org: string,
    moved: Moved[],
    context: ChangeContext,
    space?: {
      was?: SpaceEntry;
      is?: SpaceEntry;
      linked: AttributesList[];
    }
  ): Promise<void> {
    const whole = new Set<string>();
    if (space) {
      const { was, is, linked } = space;
      const id = (is ?? was)!.id;
      const names = new Map(
        linked.map(e => [
          dnKey(e.dn as string),
          read(e, this.groupName) || rdnValue(e.dn as string),
        ])
      );
      const groupOf = (
        h: Holder
      ): { id: string; name: string; role: SpaceRole } => ({
        id: h.name,
        name: names.get(dnKey(h.dn)) ?? h.name,
        role: h.role,
      });
      const publish = (event: string, fields?: Record<string, unknown>): void =>
        this.publishEvent(org, id, event, context, fields);
      if (!was || !is) {
        whole.add(id.toLowerCase());
        if (!is) publish('deleted');
        else {
          const members = moved.flatMap(m => {
            const role = m.after.get(id);
            return role ? [{ dn: m.dn, role }] : [];
          });
          const profiles = await this.profiles(
            org,
            members.map(m => m.dn)
          );
          publish('created', {
            name: is.name,
            members: members.flatMap(({ dn, role }) => {
              const profile = profiles.get(dnKey(dn));
              return profile ? [{ ...profile, role }] : [];
            }),
            groups: is.holders.filter(h => h.kind === 'group').map(groupOf),
          });
        }
      } else {
        if (was.name !== is.name) publish('updated', { name: is.name });
        const linkedBefore = new Map(
          was.holders.filter(h => h.kind === 'group').map(h => [dnKey(h.dn), h])
        );
        for (const group of is.holders.filter(h => h.kind === 'group')) {
          const held = linkedBefore.get(dnKey(group.dn));
          linkedBefore.delete(dnKey(group.dn));
          if (held?.role === group.role) continue;
          publish(held ? 'group.role.changed' : 'group.linked', {
            groups: [groupOf(group)],
          });
        }
        // A group gone was announced unlinked when it was deleted
        for (const group of linkedBefore.values())
          if (names.has(dnKey(group.dn)))
            publish('group.unlinked', { groups: [groupOf(group)] });
      }
    }

    const changes = moved.flatMap(({ dn, before, after }) =>
      [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
        const [was, is] = [before.get(id), after.get(id)];
        if (was === is || whole.has(id.toLowerCase())) return [];
        const event = !was
          ? 'member.added'
          : !is
            ? 'member.removed'
            : 'member.role.changed';
        return [{ dn, id, event, role: (is ?? was)! }];
      })
    );
    if (!changes.length) return;
    // A user deleted meanwhile has no profile, so no event
    const profiles = await this.profiles(
      org,
      changes.map(c => c.dn)
    );
    for (const { dn, id, event, role } of changes) {
      const profile = profiles.get(dnKey(dn));
      if (profile)
        this.publishEvent(org, id, event, context, {
          members: [{ ...profile, role }],
        });
    }
  }

  /** Users as space events name them, by DN key, live users only. */
  private async profiles(
    org: string,
    dns: string[]
  ): Promise<Map<string, Record<string, unknown>>> {
    if (!dns.length) return new Map();
    const username = this.groups.userAttribute;
    const mail = this.config.mail_attribute || 'mail';
    const found = new Map(
      (
        await this.groups.users(
          org,
          [...new Set(dns.map(rdnValue))],
          [username, 'entryUUID', mail, 'givenName', 'sn']
        )
      ).map(e => [(read(e, username) || '').toLowerCase(), e])
    );
    return new Map(
      dns.flatMap(dn => {
        const entry = found.get(rdnValue(dn).toLowerCase());
        if (!entry) return [];
        const profile = {
          uuid: read(entry, 'entryUUID'),
          username: read(entry, username),
          email: read(entry, mail),
          firstName: read(entry, 'givenName'),
          lastName: read(entry, 'sn'),
        };
        return [[dnKey(dn), profile] as const];
      })
    );
  }

  private publishEvent(
    org: string,
    id: string,
    event: string,
    context: ChangeContext,
    fields: Record<string, unknown> = {}
  ): void {
    const rabbitmq = this.rabbitmq;
    if (!rabbitmq) return;
    const message = {
      organizationId: org,
      id,
      ...fields,
      actor: context.actor,
      timestamp: new Date().toISOString(),
    };
    // A broker that is down holds up the events, not the role writes
    this.publishing = this.publishing.then(() =>
      this.publish(rabbitmq, event, message)
    );
  }

  private get rabbitmq(): RabbitMq | null {
    return this.config.rabbitmq_url
      ? this.requirePlugin<RabbitMq>('rabbitmq')
      : null;
  }

  private async publish(
    rabbitmq: RabbitMq,
    event: string,
    message: Record<string, unknown>
  ): Promise<void> {
    const log = {
      plugin: this.name,
      exchange: this.exchange,
      routingKey: `twake.space.${event}`,
      messageId: randomUUID(),
    };
    try {
      // core/rabbitmq drops a message silently when it has no client
      if (!(await rabbitmq.getRawClient())) {
        this.logger.error({ ...log, result: 'no broker' });
        return;
      }
      await rabbitmq.publish(log.exchange, log.routingKey, message, {
        messageId: log.messageId,
      });
      this.logger.info({ ...log, result: 'published' });
    } catch (err) {
      this.logger.error({ ...log, result: 'error', error: String(err) });
    }
  }

  /** A user's roles, in the directory as it is or with a change undone. */
  private async rolesOf(org: string, dn: string, undo?: Undo): Promise<Roles> {
    const { filter, roleIn } = await this.userIn(org, dn, undefined, undo);
    let spaces = await this.spaces(org, filter);
    if (undo && 'id' in undo) {
      const id = undo.id.toLowerCase();
      spaces = spaces.filter(s => s.id.toLowerCase() !== id);
      if (undo.space) spaces.push(undo.space);
    }
    const roles: Roles = new Map(
      spaces.flatMap(space => {
        const role = roleIn(space);
        return role ? [[space.id, role] as const] : [];
      })
    );
    // refint may have taken the deleted group out of its spaces already
    if (undo && 'group' in undo && undo.members.has(dnKey(dn)))
      for (const { id, role } of undo.spaces ?? []) {
        const held = roles.get(id);
        if (!held || SPACE_ROLES.indexOf(role) > SPACE_ROLES.indexOf(held))
          roles.set(id, role);
      }
    return roles;
  }

  /**
   * Write a user's `<space id>:<role>` values, and answer the roles they
   * held, or nothing for a user gone.
   */
  private async writeRoles(
    dn: string,
    roles: Roles
  ): Promise<Roles | undefined> {
    const attribute = this.userRole;
    const wanted = [...roles].map(([id, role]) => `${id}:${role}`);
    const keep = new Set(wanted.map(v => v.toLowerCase()));
    for (let attempt = 0; ; attempt++) {
      try {
        const [entry] = (
          (await this.server.ldap.search(
            { paged: false, scope: 'base', attributes: [attribute] },
            dn
          )) as SearchResult
        ).searchEntries;
        if (!entry) return undefined;
        const held = values(valueOf(entry, attribute));
        const has = new Set(held.map(v => v.toLowerCase()));
        const stale = held.filter(
          v => ROLE_VALUE.test(v) && !keep.has(v.toLowerCase())
        );
        const missing = wanted.filter(v => !has.has(v.toLowerCase()));
        if (stale.length || missing.length)
          await this.server.ldap.modify(dn, {
            ...(stale.length && { delete: { [attribute]: stale } }),
            ...(missing.length && { add: { [attribute]: missing } }),
          });
        return new Map(
          held.flatMap(v => {
            const role = ROLE_VALUE.exec(v)?.[1].toLowerCase() as SpaceRole;
            return role
              ? [[v.slice(0, v.lastIndexOf(':')), role] as const]
              : [];
          })
        );
      } catch (err) {
        const code = extractLdapCode(err);
        if (code === 32) return undefined;
        // Another write took or gave a value between the read and this one
        if ((code !== 16 && code !== 20) || attempt >= 2) throw err;
      }
    }
  }

  /** The groups of the organization by lowercased id, as DNs, or a 404. */
  private async groupDns(
    org: string,
    ids: string[],
    req?: Request
  ): Promise<Map<string, string>> {
    const found = new Map(
      (await this.orgGroups(org, ids, [], req)).map(e => [
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
    await this.again(() => this.addOnce(req, org, kind, role, resolve));
  }

  private async addOnce(
    req: Request,
    org: string,
    kind: Kind,
    role: SpaceRole,
    resolve: () => Promise<Map<string, string>>
  ): Promise<void> {
    const space = await this.space(org, req.params.spaceId as string, req);
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
    await this.again(() => this.changeOnce(req, org, kind, role));
  }

  private async changeOnce(
    req: Request,
    org: string,
    kind: Kind,
    role?: SpaceRole
  ): Promise<void> {
    const space = await this.space(org, req.params.spaceId as string, req);
    const name = (
      kind === 'member' ? req.params.userId : req.params.groupId
    ) as string;
    const held = space.holders.find(
      h => h.kind === kind && h.name.toLowerCase() === name.toLowerCase()
    );
    if (!held) throw notFound(kind);
    if (held.roles.length === 1 && held.role === role) return;
    const demoted =
      kind === 'member' && held.role === 'admin' && role !== 'admin';
    if (demoted && !space.holders.some(h => h !== held && isAdmin(h)))
      throw lastAdmin();
    const from = Object.fromEntries(
      held.roles
        .filter(r => r !== role)
        .map(r => [this.roleAttributes[r], held.dn])
    );
    const to =
      role && !held.roles.includes(role)
        ? { [this.roleAttributes[role]]: held.dn }
        : undefined;
    await this.write(org, space.id, { delete: from, add: to }, req);
    // Two admins removed at once both pass the check above: the one that
    // finds no admin left takes its change back.
    if (
      demoted &&
      !(await this.space(org, space.id, req)).holders.some(isAdmin)
    ) {
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
      const [dn] = (await this.liveUsers(org, [user], req)).values();
      const held = await this.userIn(org, dn, req);
      filter = `(&${filter}${held.filter})`;
      roleIn = held.roleIn;
    }
    const spaces = this.groups.sorted(
      (await this.spaces(org, filter, undefined, req)).map(s => ({
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
        members.map(m => m.name),
        req
      ),
      this.groupDns(
        org,
        groups.map(g => g.name),
        req
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
    res.status(201).json(this.spaceOf(org, await this.space(org, id, req)));
  }
}
