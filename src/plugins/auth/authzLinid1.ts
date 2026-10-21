/**
 * @module plugins/auth/authzLinid1
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Authorization plugin based on twakeLocalAdminLink LDAP attribute
 * Grants permissions to users referenced in organization's twakeLocalAdminLink
 * @group Plugins
 */
import type { DM } from '../../bin';
import type { SearchResult } from '../../lib/ldapActions';
import type { BranchPermissions } from '../../config/args';
import AuthzBase from '../../lib/authz/base';
import { escapeLdapFilter, isDnInBranch } from '../../lib/utils';

interface CachedPermissions {
  branches: Map<string, BranchPermissions>;
  timestamp: number;
}

export default class AuthzLinid1 extends AuthzBase {
  name = 'authzLinid1';
  permissionsCache: Map<string, CachedPermissions> = new Map();

  constructor(server: DM) {
    super(server);

    // Cache TTL in milliseconds (default: 5 minutes)
    this.cacheTTL = 5 * 60 * 1000;

    const adminAttr =
      this.config.authz_local_admin_attribute || 'twakeLocalAdminLink';
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
  }

  /** The organization holding the global branches */
  private globalOrganization(): string | undefined {
    return (
      this.config.authz_global_organization ||
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
    return this.config.authz_global_branch ?? [];
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
    return this.config.authz_global_write_branch ?? [];
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
   */
  async resolveUser(uid: string): Promise<string | null> {
    return this.getUserDn(uid);
  }

  // Note: hooks are inherited from AuthzBase

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

    // Refresh permissions from LDAP
    await this.refreshUserPermissions(userDn);

    // Try again from cache
    const updatedCache = this.permissionsCache.get(userDn);
    if (updatedCache) {
      const branchPerms = this.findBranchPermissions(
        updatedCache.branches,
        branch
      );
      if (branchPerms) {
        return branchPerms;
      }
    }

    // No permissions found - return default deny
    return { read: false, write: false, delete: false };
  }

  /**
   * Refresh user permissions from LDAP
   */
  async refreshUserPermissions(userDn: string): Promise<void> {
    const branches = new Map<string, BranchPermissions>();

    try {
      // Search for all organizations where this user is in local admin attribute
      const adminAttr =
        this.config.authz_local_admin_attribute || 'twakeLocalAdminLink';
      const filter = `(${adminAttr}=${escapeLdapFilter(userDn)})`;
      const orgBase =
        this.config.ldap_top_organization || this.config.ldap_base || '';

      const result = (await this.server.ldap.search(
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

    // Update cache
    this.permissionsCache.set(userDn, {
      branches,
      timestamp: Date.now(),
    });
  }

  /**
   * Get list of branches user has access to
   */
  async getAuthorizedBranches(userDn: string): Promise<string[]> {
    const now = Date.now();

    // Check cache
    const cached = this.permissionsCache.get(userDn);
    if (!cached || now - cached.timestamp >= this.cacheTTL) {
      await this.refreshUserPermissions(userDn);
    }

    const updatedCache = this.permissionsCache.get(userDn);
    if (updatedCache) {
      return Array.from(updatedCache.branches.keys());
    }

    return [];
  }

  /**
   * Find permissions for a branch (supports sub-branch matching)
   */
  private findBranchPermissions(
    branchPerms: Map<string, BranchPermissions>,
    targetBranch: string
  ): BranchPermissions | null {
    // Exact match first
    if (branchPerms.has(targetBranch)) {
      return branchPerms.get(targetBranch) || null;
    }

    // Check if targetBranch is a sub-branch of any configured branch
    for (const [branch, perms] of branchPerms.entries()) {
      if (targetBranch.toLowerCase().endsWith(`,${branch.toLowerCase()}`)) {
        return perms;
      }
    }

    return null;
  }
}
