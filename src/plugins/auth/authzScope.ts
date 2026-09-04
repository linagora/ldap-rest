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
import type { DmRequest } from '../../lib/auth/base';
import type { BranchPermissions } from '../../config/args';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { asyncHandler } from '../../lib/utils';
import { UnauthorizedError } from '../../lib/errors';

/** The part of an authorization plugin this endpoint needs. */
interface AuthzLike {
  roles?: Role[];
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
     *   With no authorization plugin loaded the server grants everything, and
     *   the answer says so through `unrestricted: true`.
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
   * The authorization plugin in force, if any.
   *
   * @returns the plugin, or undefined when the server is unrestricted
   */
  private authz(): AuthzLike | undefined {
    // The `authz` role says a plugin restricts something, not that it can
    // answer *who may do what where*: `authzPerRoute` gates URLs and
    // `authzDynamic` reads a token, and neither resolves a user or a branch.
    // Both carry the role, and `authzPerRoute` sits in priority.json, so it is
    // registered before any branch-level plugin — picking by role alone made
    // this endpoint answer 500 to every caller on any server combining the
    // two. Ask for the capability instead, and fall through to the
    // unrestricted answer when nothing provides it.
    return Object.values(this.server.loadedPlugins).find(plugin => {
      if (!plugin.roles?.includes('authz')) return false;
      const candidate = plugin as unknown as Partial<AuthzLike>;
      return (
        typeof candidate.resolveUser === 'function' &&
        typeof candidate.getAuthorizedBranches === 'function' &&
        typeof candidate.getUserPermissions === 'function'
      );
    }) as AuthzLike | undefined;
  }

  /**
   * Entities a client can create, as declared by the loaded plugins.
   *
   * @returns entity name and branch, one per creatable entity
   */
  private entities(): { name: string; base: string }[] {
    const out: { name: string; base: string }[] = [];
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      | { instances?: { base: string; pluralName: string }[] }
      | undefined;
    for (const instance of flat?.instances || [])
      out.push({ name: instance.pluralName, base: instance.base });

    const groups = this.server.loadedPlugins['ldapGroups'] as
      | { base?: string }
      | undefined;
    if (groups?.base) out.push({ name: 'groups', base: groups.base });

    if (
      this.server.loadedPlugins['ldapOrganizations'] &&
      this.config.ldap_top_organization
    )
      out.push({
        name: 'organizations',
        base: this.config.ldap_top_organization,
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
    const authz = this.authz();
    if (!authz) {
      res.json({
        user: req.user ?? null,
        unrestricted: true,
        branches: [],
        entities: this.entities().map(e => ({ ...e, create: true })),
      });
      return;
    }

    if (!req.user) throw new UnauthorizedError('No authenticated user');
    const user = await authz.resolveUser(req.user);
    if (!user) throw new UnauthorizedError(`Unknown user ${req.user}`);

    const branchDns = await authz.getAuthorizedBranches(user);
    const branches = [];
    for (const dn of branchDns) {
      const permissions = await authz.getUserPermissions(user, dn);
      branches.push({ dn, ...permissions, ...(await this.branchLabel(dn)) });
    }

    // "Can I create a user?" is not a question about the user branch: an entry
    // is scoped by the organization it is attached to, so the answer turns on
    // the branches the caller administers rather than on where the entry
    // lands. It turns on *write* on one of them, which is what the add hook
    // checks — administering a branch read-only used to report `create: true`
    // and every submission then came back 403, which is exactly the round trip
    // this endpoint exists to spare the client.
    const writable = await this.canWriteAny(authz, user, branchDns);
    const entities: CreatableEntity[] = [];
    for (const entity of this.entities()) {
      entities.push({ ...entity, create: writable });
    }

    res.json({
      user,
      unrestricted: false,
      branches,
      entities,
    });
  }

  /**
   * Tell whether the user may write in at least one of their branches.
   *
   * @param authz authorization plugin
   * @param user resolved user identity
   * @param branches branches the user administers
   * @returns true when at least one grants write
   */
  private async canWriteAny(
    authz: AuthzLike,
    user: string,
    branches: string[]
  ): Promise<boolean> {
    for (const branch of branches) {
      const permissions = await authz.getUserPermissions(user, branch);
      if (permissions.write) return true;
    }
    return false;
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
    const pathAttr = this.config.ldap_organization_path_attribute;
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
