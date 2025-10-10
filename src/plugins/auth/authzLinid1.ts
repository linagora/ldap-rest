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
   */
  async getUserDn(uid: string): Promise<string | null> {
    try {
      const filter = `(${this.config.ldap_user_main_attribute || 'uid'}=${uid})`;
      const result = (await this.server.ldap.search(
        {
          paged: false,
          filter,
          attributes: ['dn'],
          scope: 'sub',
        },
        this.config.ldap_base || ''
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        const dn = result.searchEntries[0].dn;
        return typeof dn === 'string' ? dn : String(dn);
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error(`Failed to get DN for user ${uid}: ${err}`);
    }

    return null;
  }

  /**
   * Get user's permissions for a specific branch
   * Searches LDAP for organizations with twakeLocalAdminLink containing the user's DN
   */
  async getUserPermissions(
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
      const filter = `(${adminAttr}=${userDn})`;
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
