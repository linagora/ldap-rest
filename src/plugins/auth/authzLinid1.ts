/**
 * @module plugins/auth/authzLinid1
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Authorization plugin based on twakeLocalAdminLink LDAP attribute
 * Grants permissions to users referenced in organization's twakeLocalAdminLink
 * @group Plugins
 */
import type { DM } from '../../bin/index.js';
import { roleAttribute, type Schema } from '../../config/schema.js';
import type { Hooks, MaybePromise } from '../../hooks.js';
import type { ModifyRequest, SearchResult } from '../../lib/ldapActions.js';
import type { BranchPermissions } from '../../config/args.js';
import AuthzBase, { mostSpecificBranchRule } from '../../lib/authz/base.js';
import { AuthzRefusedError } from '../../lib/errors.js';
import {
  escapeLdapFilter,
  isDnInBranch,
  normalizeDn,
  organizationLink,
} from '../../lib/utils.js';

interface CachedPermissions {
  branches: Map<string, BranchPermissions>;
  timestamp: number;
}

import { linid1Options } from './auth.options.js';

export default class AuthzLinid1 extends AuthzBase {
  static optionDefinitions = linid1Options;

  name = 'authzLinid1';
  permissionsCache: Map<string, CachedPermissions> = new Map();
  /**
   * Bumped by every invalidation. A refresh that started before a write may
   * have read the directory before it, so it must not put what it read back
   * into the cache afterwards.
   */
  private permissionsGeneration = 0;

  declare hooks: AuthzBase['hooks'] &
    Pick<Hooks, 'ldapmodifydone' | 'ldapdeletedone' | 'ldaprenamedone'>;

  /** What the classes above declared, read once this one is constructed */
  private readonly declaredByBase: Hooks;

  constructor(server: DM) {
    super(server);
    this.declaredByBase = { ...this.hooks };

    this.cacheTTL = this.options(linid1Options).authz_linid1_cache_ttl * 1000;

    const adminAttr = this.options(linid1Options).authz_local_admin_attribute;
    this.logger.info(
      `AuthzLinid1: Authorization based on ${adminAttr} attribute enabled`
    );

    // Its administrators would be held to it by itself: nobody would
    // administer it, nor anything under it
    const owner = this.globalOrganization();
    const holding =
      owner && this.globalBranches().find(dn => isDnInBranch(owner, dn));
    if (holding)
      throw new Error(
        `AuthzLinid1: --authz-global-organization ${owner} lies in the ` +
          `global branch ${holding}`
      );
    const writeHolding =
      owner && this.globalWriteBranches().find(dn => isDnInBranch(owner, dn));
    if (writeHolding)
      throw new Error(
        `AuthzLinid1: --authz-global-organization ${owner} lies in the ` +
          `global write branch ${writeHolding}`
      );
    // One branch under two rules: the global one, checked first, would
    // hide a write branch it holds from the administrators meant to read
    // it, and a global branch inside a write branch would read as one
    for (const write of this.globalWriteBranches()) {
      const global = this.globalBranches().find(
        dn => isDnInBranch(write, dn) || isDnInBranch(dn, write)
      );
      if (global)
        throw new Error(
          `AuthzLinid1: the global branch ${global} and the global write ` +
            `branch ${write} overlap`
        );
    }

    // A revoked administrator keeps the grants cached until the TTL runs
    // out, and a write through this server says what it touched: drop the
    // map then. A rename or delete moves the organization naming them, so
    // it drops the map too. The base hooks run after, as they do for the
    // other in-process writes.
    const touches = (changes: ModifyRequest, attrs: string[]): boolean => {
      const names = [
        ...Object.keys(changes.add ?? {}),
        ...Object.keys(changes.replace ?? {}),
        ...(Array.isArray(changes.delete)
          ? changes.delete
          : Object.keys(changes.delete ?? {})),
      ].map(name => name.split(';')[0].toLowerCase());
      return attrs.some(attr => names.includes(attr.toLowerCase()));
    };
    this.hooks = {
      ...this.declaredByBase,
      ldapmodifydone: (dn, changes, op, context): MaybePromise<void> => {
        if (touches(changes, [adminAttr])) this.forgetPermissions();
        // A suspension through this server takes effect on the next request
        if (touches(changes, this.statusAttributes()))
          this.clearResolutionCache();
        return this.declaredByBase.ldapmodifydone?.(dn, changes, op, context);
      },
      ldapdeletedone: (dn, context): MaybePromise<void> => {
        this.forgetPermissions();
        return this.declaredByBase.ldapdeletedone?.(dn, context);
      },
      ldaprenamedone: (dn, newDn, context): MaybePromise<void> => {
        this.forgetPermissions();
        return this.declaredByBase.ldaprenamedone?.(dn, newDn, context);
      },
    };
  }

  /** Drop every cached permission lookup. */
  forgetPermissions(): void {
    this.permissionsGeneration++;
    this.permissionsCache.clear();
  }

  /**
   * The organizations naming `dn` an administrator. Taking one of those
   * accounts over grants its branches, so the base refuses a caller who
   * does not hold them all.
   */
  protected async administeredBranches(dn: string): Promise<string[]> {
    const adminAttr = this.options(linid1Options).authz_local_admin_attribute;
    const orgBase =
      this.config.ldap_top_organization || this.config.ldap_base || '';
    if (!orgBase) return [];
    const result = (await this.server.ldap.system.search(
      {
        paged: false,
        filter: `(${adminAttr}=${escapeLdapFilter(dn)})`,
        attributes: ['dn'],
        scope: 'sub',
      },
      orgBase
    )) as SearchResult;
    return (result.searchEntries ?? []).map(entry => String(entry.dn));
  }

  /**
   * The administrators of the global organization link any domain too: they
   * create and delete the domains (`--authz-global-write-branches`), and the
   * top organization may be a bare container nobody administers.
   */
  async mayLinkAnyDomain(user: string): Promise<boolean> {
    if (await super.mayLinkAnyDomain(user)) return true;
    const owner = this.globalOrganization();
    if (!owner) return false;
    return (await this.getUserPermissions(user, owner)).write === true;
  }

  /** The organization holding the global branches */
  private globalOrganization(): string | undefined {
    return (
      this.options(linid1Options).authz_global_organization ||
      this.config.ldap_top_organization ||
      undefined
    );
  }

  /**
   * Always: the branches this plugin grants are organizations, and what an
   * administrator manages in them is the accounts and groups whose
   * organization link names them, wherever they are stored. Judged by their
   * parent instead, a flat `ou=users` is nobody's branch, and every
   * administrator is refused every account.
   */
  protected filtersAttachedEntries(): boolean {
    return true;
  }

  protected globalBranches(): string[] {
    return this.options(linid1Options).authz_global_branch;
  }

  /**
   * Branches written and deleted in by the holders of the global
   * organization only, and read as the rest of the reference data is: the
   * mail domains, which every administrator needs to read and none but the
   * administrators of the whole directory should add or remove. Unlike
   * {@link globalBranches}, the base class's read checks do not know them: a
   * search there is filtered no more than in any other branch outside the
   * tree.
   */
  private globalWriteBranches(): string[] {
    return this.options(linid1Options).authz_global_write_branch;
  }

  private isGlobalWrite(branch: string): boolean {
    return this.globalWriteBranches().some(dn => isDnInBranch(branch, dn));
  }

  /**
   * Taking an entry out of a global write branch removes it from there: it
   * asks what a delete asks, not the read every administrator holds
   */
  protected sourcePermission(branch: string): keyof BranchPermissions {
    return this.isGlobalWrite(branch) ? 'delete' : 'read';
  }

  /**
   * Resolve user - for authzLinid1, convert uid to userDn via LDAP
   *
   * An account the schema marks with a state other than `enabled` is
   * refused: the identity provider may still let it sign in, and the
   * lifecycle state is the directory's way to stop it.
   */
  async resolveUser(uid: string): Promise<string | null> {
    const dn = await this.getUserDn(uid);
    if (!dn) return null;
    if (!(await this.enabled(dn)))
      throw new AuthzRefusedError(`User ${uid} is not enabled`);
    return dn;
  }

  /**
   * The attribute carrying an account's lifecycle state, and the value that
   * means enabled, from the flat entity schema holding `dn`.
   */
  private accountStatus(
    dn: string
  ): { attribute: string; enabled: string } | undefined {
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      { instances?: { base: string; schema?: Schema }[] } | undefined;
    const holding = (flat?.instances ?? [])
      .filter(
        instance =>
          instance.schema && instance.base && isDnInBranch(dn, instance.base)
      )
      .sort(
        (left, right) =>
          normalizeDn(right.base).length - normalizeDn(left.base).length
      );
    for (const instance of holding) {
      const attribute = roleAttribute(instance.schema, 'accountStatus');
      const value = attribute
        ? instance.schema?.attributes[attribute]?.states?.enabled
        : undefined;
      const enabled = organizationLink(value);
      if (attribute && enabled) return { attribute, enabled };
    }
    return undefined;
  }

  /**
   * Whether the account carries the enabled state, or carries no status at
   * all: an entry the schema does not manage keeps the access it had.
   */
  private async enabled(dn: string): Promise<boolean> {
    const status = this.accountStatus(dn);
    if (!status) return true;
    // As the server: the judgement's own read: as the caller, it would be
    // judged by itself. A failed read propagates, as it does for the
    // identity itself: a cached "enabled" from a failed read would reopen
    // the suspension for the whole TTL.
    const result = (await this.server.ldap.system.search(
      { paged: false, scope: 'base', attributes: [status.attribute] },
      dn
    )) as SearchResult;
    const entry = result.searchEntries?.[0];
    // The schema may spell the name in another case than the directory
    const key = Object.keys(entry ?? {}).find(
      name =>
        name.split(';')[0].toLowerCase() === status.attribute.toLowerCase()
    );
    const value = organizationLink(key ? entry?.[key] : undefined);
    return (
      value === undefined || normalizeDn(value) === normalizeDn(status.enabled)
    );
  }

  /** The account status attributes the loaded user schemas declare. */
  private statusAttributes(): string[] {
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      { instances?: { schema?: Schema }[] } | undefined;
    const attributes = new Set<string>();
    for (const instance of flat?.instances ?? []) {
      const attribute = roleAttribute(instance.schema, 'accountStatus');
      if (attribute) attributes.add(attribute);
    }
    return [...attributes];
  }

  /**
   * Get user DN from uid
   *
   * An identity naming several entries is refused (`AmbiguousIdentityError`)
   * rather than answered with `null`: under `--authz-unresolved-user allow`,
   * `null` means "skip authorization", so an ambiguous directory would open
   * every branch. A failed search propagates for the same reason — it used
   * to read as `null` too, and `resolveCaller` then cached it.
   */
  async getUserDn(uid: string): Promise<string | null> {
    return this.findUserDn(uid);
  }

  /**
   * Get user's permissions for a specific branch
   * Searches LDAP for organizations with twakeLocalAdminLink containing the user's DN
   */
  async getUserPermissions(
    userDn: string,
    branch: string
  ): Promise<BranchPermissions> {
    // A global branch is held by whoever holds its organization
    const owner = this.globalOrganization();
    if (this.globalBranches().some(dn => isDnInBranch(branch, dn)))
      return owner && !isDnInBranch(owner, branch)
        ? this.getUserPermissions(userDn, owner)
        : { read: false, write: false, delete: false };
    // A global write branch is written by whoever holds that organization,
    // and read by every administrator, as the rest of the reference data
    if (this.isGlobalWrite(branch)) {
      const held =
        owner && !isDnInBranch(owner, branch)
          ? await this.getUserPermissions(userDn, owner)
          : { read: false, write: false, delete: false };
      return {
        read:
          held.read || (await this.getAuthorizedBranches(userDn)).length > 0,
        write: held.write,
        delete: held.delete,
      };
    }
    return this.ownPermissions(userDn, branch);
  }

  /**
   * A user's permissions on a branch from the organizations naming them,
   * the global branches aside
   */
  private async ownPermissions(
    userDn: string,
    branch: string
  ): Promise<BranchPermissions> {
    const now = Date.now();

    // Check cache
    const cached = this.permissionsCache.get(userDn);
    if (cached && now - cached.timestamp < this.cacheTTL) {
      const branchPerms = this.findBranchPermissions(cached.branches, branch);
      if (branchPerms) {
        return branchPerms;
      }
    }

    // Refresh permissions from LDAP. What this read answers the caller
    // even when a write invalidated the cache meanwhile: answering from a
    // read that started before the write orders this request before it,
    // which is the same ordering a check-then-act write would have.
    const branches = await this.refreshUserPermissions(userDn);
    const branchPerms = this.findBranchPermissions(branches, branch);
    if (branchPerms) return branchPerms;

    // No permissions found - return default deny
    return { read: false, write: false, delete: false };
  }

  /**
   * Refresh user permissions from LDAP.
   *
   * @param userDn the administrator's DN
   * @returns the branches this lookup read, whether or not it was cached
   */
  async refreshUserPermissions(
    userDn: string
  ): Promise<Map<string, BranchPermissions>> {
    const generation = this.permissionsGeneration;
    const branches = new Map<string, BranchPermissions>();

    try {
      // Search for all organizations where this user is in local admin attribute
      const adminAttr = this.options(linid1Options).authz_local_admin_attribute;
      const filter = `(${adminAttr}=${escapeLdapFilter(userDn)})`;
      const orgBase =
        this.config.ldap_top_organization || this.config.ldap_base || '';

      // As the server: the caller's rights, read before any judgement
      const result = (await this.server.ldap.system.search(
        {
          paged: false,
          filter,
          attributes: ['dn'],
          scope: 'sub',
        },
        orgBase
      )) as SearchResult;

      if (result.searchEntries) {
        for (const entry of result.searchEntries) {
          const dn = typeof entry.dn === 'string' ? entry.dn : String(entry.dn);
          // Grant full permissions (read, write, delete) for managed branches
          branches.set(dn, { read: true, write: true, delete: true });
        }
      }
    } catch (err) {
      this.logger.error(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Failed to refresh permissions for user ${userDn}: ${err}`
      );
    }

    // A write invalidated the map while this refresh was searching: what
    // was read may predate it, and the next call must search again.
    if (generation === this.permissionsGeneration)
      this.permissionsCache.set(userDn, {
        branches,
        timestamp: Date.now(),
      });
    return branches;
  }

  /**
   * Get list of branches user has access to
   */
  async getAuthorizedBranches(userDn: string): Promise<string[]> {
    const now = Date.now();

    // Check cache
    const cached = this.permissionsCache.get(userDn);
    if (!cached || now - cached.timestamp >= this.cacheTTL) {
      return Array.from((await this.refreshUserPermissions(userDn)).keys());
    }

    return Array.from(cached.branches.keys());
  }

  /** The organizations naming the user an administrator */
  ruleBranches(userDn: string): Promise<string[]> {
    return this.getAuthorizedBranches(userDn);
  }

  /**
   * The caller's rights on a branch: see {@link mostSpecificBranchRule}.
   */
  private findBranchPermissions(
    branchPerms: Map<string, BranchPermissions>,
    targetBranch: string
  ): BranchPermissions | null {
    return mostSpecificBranchRule(branchPerms.entries(), targetBranch);
  }
}
