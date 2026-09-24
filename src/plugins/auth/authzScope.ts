/**
 * @module plugins/auth/authzScope
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Tells a client what the signed-in administrator may actually do, before it
 * offers them a button that will fail.
 *
 * In a local-administration model the scope *is* the interface: a manager
 * administers a few branches of the tree and nothing else, and an application
 * that cannot name those branches leaves them guessing. This endpoint answers
 * both halves — which branches, and which entities can be created in them —
 * by asking the authorization plugin in force, whichever one that is.
 * @group Plugins
 */
import type { Express, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { identityFor, type DmRequest } from '../../lib/auth/base';
import {
  authzFor,
  EVERYONE,
  overlap,
  servesRequest,
} from '../../lib/authz/composition';
import type { BranchPermissions } from '../../config/args';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { asyncHandler } from '../../lib/utils';
import { UnauthorizedError } from '../../lib/errors';
import { roleAttribute, type Schema } from '../../config/schema';

/** The part of an authorization plugin this endpoint needs. */
interface AuthzLike extends DmPlugin {
  resolveUser(uid: string): Promise<string | null>;
  getAuthorizedBranches(user: string): Promise<string[]>;
  getUserPermissions(user: string, branch: string): Promise<BranchPermissions>;
}

/** One entity, and whether the caller may create one. */
interface CreatableEntity {
  name: string;
  base: string;
  create: boolean;
}

/** An entity a client can create into, as the plugins declare it. */
interface EntityInfo {
  name: string;
  base: string;
  /**
   * Whether its entries may carry the organization link. The add hook checks
   * write on the linked organization for those, and on the branch the entry
   * lands in for the others.
   */
  linkable: boolean;
}

export default class AuthzScope extends DmPlugin {
  name = 'authzScope';
  roles: Role[] = ['api'] as const;

  /**
   * Register `GET {api_prefix}/v1/authz/scope`.
   *
   * @param app Express application
   */
  api(app: Express): void {
    /**
     * @openapi
     * summary: Administration scope of the current user
     * description: |
     *   Returns the branches the signed-in user administers, the permissions
     *   held on each, and — per entity — whether they may create a new entry.
     *   A client uses it to show the scope explicitly and to hide actions that
     *   would be refused.
     *
     *   With no authorization plugin judging the caller the server grants
     *   everything, and the answer says so through `unrestricted: true`.
     *   When plugins judge the caller and none of them can describe a scope
     *   (`authzPerRoute`, `authzDynamic`), the answer is `described: false`
     *   with nothing in it: no model can say what will be granted, and a
     *   client should not offer what it cannot know.
     *
     *   `sources` names the authorization plugins judging the caller, and
     *   `source` the one this scope comes from — the first loaded, or the one
     *   `--authz-scope-source` names — so a client can tell a scope from one
     *   model among several from the server's whole answer.
     * tags:
     *   - Authorization
     * responses:
     *   '200':
     *     description: Scope of the current user.
     *     content:
     *       application/json:
     *         example:
     *           user: uid=alice,ou=users,dc=example,dc=com
     *           unrestricted: false
     *           described: true
     *           source: authzLinid1
     *           sources: [authzLinid1]
     *           branches:
     *             - dn: ou=Sales,ou=organization,dc=example,dc=com
     *               read: true
     *               write: true
     *               delete: true
     *           entities:
     *             - name: users
     *               base: ou=users,dc=example,dc=com
     *               create: true
     *   '401':
     *     description: No authenticated user.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${this.config.api_prefix}/v1/authz/scope`,
      asyncHandler(async (req: DmRequest, res: Response) =>
        this.scope(req, res)
      )
    );
  }

  /**
   * Whether a plugin can say who may do what where.
   *
   * The `authz` role says a plugin restricts something, not that it can
   * answer that: `authzPerRoute` gates URLs and `authzDynamic` reads a token,
   * and neither resolves a user or a branch. Both carry the role, and
   * `authzPerRoute` sits in priority.json, so it is registered before any
   * branch-level plugin — picking by role alone made this endpoint answer 500
   * to every caller on any server combining the two. The capability is what
   * is asked for.
   *
   * @param plugin a loaded plugin
   * @returns true when it resolves users and reads branch permissions
   */
  private static canDescribe(plugin: DmPlugin): plugin is AuthzLike {
    if (!plugin.roles?.includes('authz')) return false;
    const candidate = plugin as unknown as Partial<AuthzLike>;
    return (
      typeof candidate.resolveUser === 'function' &&
      typeof candidate.getAuthorizedBranches === 'function' &&
      typeof candidate.getUserPermissions === 'function'
    );
  }

  /** @returns the loaded plugins able to describe a scope, in load order */
  private describers(): AuthzLike[] {
    return Object.values(this.server.loadedPlugins).filter(plugin =>
      AuthzScope.canDescribe(plugin)
    );
  }

  /**
   * Whether a plugin judges this request.
   *
   * One that authenticates too — `authzDynamic` — judges the requests it
   * vouched for, which carry its token; the others, the requests of the
   * authenticators `--authz-for` gives them, and only when they carry an
   * identity: an anonymous request passes every one of them.
   *
   * @param plugin an authorization plugin
   * @param req the request
   * @returns true when the plugin's verdict applies to it
   */
  private static judges(plugin: DmPlugin, req: DmRequest): boolean {
    if (plugin.roles?.includes('auth'))
      return Boolean(req.authenticators?.includes(plugin.name));
    return Boolean(req.user) && servesRequest(req, plugin.config);
  }

  /**
   * Refuse a `--authz-scope-source` naming nothing that can describe a scope.
   *
   * Read leniently, a typo would fall back to the first plugin loaded, which
   * is the choice the option exists to take away from load order.
   */
  assertComposition(): void {
    const named = this.config.authz_scope_source;
    if (!named) return;
    const describers = this.describers().map(plugin => plugin.name);
    if (!describers.includes(named))
      throw new Error(
        `${this.name}: --authz-scope-source names ${named}, which is not a ` +
          'loaded plugin able to describe a scope' +
          (describers.length > 0 ? ` (loaded: ${describers.join(', ')})` : '')
      );
  }

  /**
   * Say, at startup, when the scope depends on which plugin loaded first.
   *
   * Two plugins able to describe a scope, both judging one caller, is two
   * models of what that caller may do; the hooks apply both, and this
   * endpoint can only describe one. Without `--authz-scope-source` it is
   * the first loaded — import-completion order for plugins outside
   * priority.json, which is not a decision anyone took.
   */
  afterLoad(): void {
    if (this.config.authz_scope_source) return;
    const describers = this.describers();
    const authenticators = this.server.authenticators;
    const population = (plugin: AuthzLike): string[] | typeof EVERYONE =>
      authzFor(plugin.config, plugin.name) ?? EVERYONE;
    for (let i = 0; i < describers.length; i++)
      for (let j = i + 1; j < describers.length; j++) {
        const a = describers[i];
        const b = describers[j];
        if (!overlap(population(a), population(b), authenticators)) continue;
        this.logger.warn(
          `${this.name}: ${a.name} and ${b.name} can both describe the scope ` +
            `of one caller, and ${a.name} answers because it loaded first. ` +
            'Set --authz-scope-source to choose; the answer lists both under ' +
            '`sources`'
        );
        return;
      }
  }

  /**
   * Entities a client can create, as declared by the loaded plugins.
   *
   * @returns entity name and branch, one per creatable entity
   */
  private entities(): EntityInfo[] {
    const linkAttr = (
      this.config.ldap_organization_link_attribute || ''
    ).toLowerCase();
    // The add hook reads the configured link attribute, so the question is
    // whether the schema lets an entry carry it. With no schema, nothing stops
    // a client sending it.
    const linkable = (schema?: { attributes?: object }): boolean =>
      Boolean(linkAttr) &&
      (!schema?.attributes ||
        Object.keys(schema.attributes).some(
          name => name.toLowerCase() === linkAttr
        ));

    const out: EntityInfo[] = [];
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      | {
          instances?: {
            base: string;
            pluralName: string;
            schema?: { attributes?: object };
          }[];
        }
      | undefined;
    for (const instance of flat?.instances || [])
      out.push({
        name: instance.pluralName,
        base: instance.base,
        linkable: linkable(instance.schema),
      });

    const groups = this.server.loadedPlugins['ldapGroups'] as
      | { base?: string; schema?: { attributes?: object } }
      | undefined;
    if (groups?.base)
      out.push({
        name: 'groups',
        base: groups.base,
        linkable: linkable(groups.schema),
      });

    if (
      this.server.loadedPlugins['ldapOrganizations'] &&
      this.config.ldap_top_organization
    )
      out.push({
        name: 'organizations',
        base: this.config.ldap_top_organization,
        linkable: false,
      });
    return out;
  }

  /**
   * Answer the scope request.
   *
   * @param req Express request, carrying the authenticated user
   * @param res Express response
   */
  private async scope(req: DmRequest, res: Response): Promise<void> {
    // An anonymous caller is refused as soon as anything authorizes: every
    // plugin skips a request without an identity, so nothing would judge
    // them here and the answer would be `unrestricted` — the one an
    // identified caller of the same server does not get. Only a server with
    // no authorization at all is unrestricted, and it is for anyone.
    const describers = this.describers();
    const authorizes = Object.values(this.server.loadedPlugins).some(plugin =>
      plugin.roles?.includes('authz')
    );
    if (authorizes && !req.user)
      throw new UnauthorizedError('No authenticated user');

    // Every authorization plugin whose verdict applies to this caller, and
    // the one describing them: the named source when it judges them, the
    // first loaded otherwise. A describer that does not judge this caller
    // (`--authz-for`) is not their model, whatever it would answer.
    const sources = Object.values(this.server.loadedPlugins).filter(
      plugin =>
        plugin.roles?.includes('authz') && AuthzScope.judges(plugin, req)
    );
    const judging = describers.filter(plugin => sources.includes(plugin));
    const named = this.config.authz_scope_source;
    const authz = judging.find(plugin => plugin.name === named) ?? judging[0];
    const sourceNames = sources.map(plugin => plugin.name);

    if (!authz) {
      if (sources.length === 0) {
        res.json({
          user: req.user ?? null,
          unrestricted: true,
          described: true,
          source: null,
          sources: [],
          branches: [],
          entities: this.entities().map(({ name, base }) => ({
            name,
            base,
            create: true,
          })),
        });
        return;
      }
      // Something restricts this caller and nothing can say what. Answering
      // `unrestricted` with `create: true` everywhere — what this endpoint
      // did — hands a client an authorization judgement it then acts on,
      // and the refusal comes from the route or the token instead. Nothing
      // is offered rather than everything: a client enumerating entities
      // reads a missing one as not creatable.
      res.json({
        user: req.user ?? null,
        unrestricted: false,
        described: false,
        source: null,
        sources: sourceNames,
        branches: [],
        entities: [],
      });
      return;
    }

    // The name the hooks key on, not `req.user` as such: under
    // `--authz-identity req.userName` the hooks judge the login, and a scope
    // read for the other name describes somebody else.
    const identity = identityFor(req, authz.config).value as string;
    const user = await authz.resolveUser(identity);
    if (!user) throw new UnauthorizedError(`Unknown user ${identity}`);

    const branchDns = await authz.getAuthorizedBranches(user);
    const branches = [];
    const known = new Map<string, BranchPermissions>();
    const permissionsOn = async (dn: string): Promise<BranchPermissions> => {
      let permissions = known.get(dn);
      if (!permissions) {
        permissions = await authz.getUserPermissions(user, dn);
        known.set(dn, permissions);
      }
      return permissions;
    };
    for (const dn of branchDns) {
      const permissions = await permissionsOn(dn);
      branches.push({ dn, ...permissions, ...(await this.branchLabel(dn)) });
    }

    // "Can I create a user?" is not a question about the user branch: an entry
    // is scoped by the organization it is attached to, so the answer turns on
    // the branches the caller administers rather than on where the entry
    // lands. It turns on *write* on one of them, which is what the add hook
    // checks — administering a branch read-only used to report `create: true`
    // and every submission then came back 403, which is exactly the round trip
    // this endpoint exists to spare the client.
    const writable = branchDns.some(dn => known.get(dn)?.write === true);
    // Organizations are the exception: they are not attached to a branch, they
    // *are* one, so the add hook checks write permission on the node the new
    // one hangs from — the top of the tree, which is where the create endpoint
    // puts it when the client names no parent. A local administrator of
    // ou=Sales writes in their own branch and not there, and answering
    // `writable` offered them a "new organization" button whose every
    // submission came back 403.
    //
    // Only an entry that can carry the link is scoped that way, though. The
    // add hook checks the others — positions, nomenclature rows — against the
    // branch they land in, so answering `writable` for them offered a "new
    // position" to an administrator of ou=Sales, and the creation was refused.
    const tree = this.config.ldap_top_organization;
    const entities: CreatableEntity[] = [];
    for (const { name, base, linkable } of this.entities()) {
      const create =
        tree && base === tree
          ? (await permissionsOn(tree)).write === true
          : linkable
            ? writable
            : (await permissionsOn(base)).write === true;
      entities.push({ name, base, create });
    }

    res.json({
      user,
      unrestricted: false,
      described: true,
      source: authz.name,
      sources: sourceNames,
      branches,
      entities,
    });
  }

  /**
   * Read the display name and path of a branch, so a client can show the
   * scope in the words the directory uses rather than as a raw DN.
   *
   * @param dn branch to describe
   * @returns name and path when the entry carries them
   */
  private async branchLabel(
    dn: string
  ): Promise<{ name?: string; path?: string }> {
    // The role first, as the enterprise rules read it: a deployment naming
    // the path attribute only through the schema got raw DNs in the sidebar.
    const organizations = this.server.loadedPlugins['ldapOrganizations'] as
      | { schema?: Schema }
      | undefined;
    const pathAttr =
      roleAttribute(organizations?.schema, 'organizationPath') ||
      this.config.ldap_organization_path_attribute;
    try {
      const result = (await this.server.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: ['ou', 'o', 'cn', ...(pathAttr ? [pathAttr] : [])],
        },
        dn
      )) as SearchResult;
      const entry = result?.searchEntries?.[0] as AttributesList | undefined;
      if (!entry) return {};
      const first = (value: unknown): string | undefined => {
        const one = Array.isArray(value) ? (value[0] as unknown) : value;
        if (typeof one === 'string') return one || undefined;
        if (Buffer.isBuffer(one)) return one.toString('utf8') || undefined;
        return undefined;
      };
      return {
        name: first(entry.ou) || first(entry.o) || first(entry.cn),
        path: pathAttr ? first(entry[pathAttr]) : undefined,
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      return {};
    }
  }
}
