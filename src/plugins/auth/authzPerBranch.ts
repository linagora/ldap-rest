/**
 * @module plugins/auth/authzPerBranch
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Authorization plugin that restricts LDAP access by branch
 * Supports user and group-based permissions with configurable defaults
 * @group Plugins
 */
import type { DM } from '../../bin';
import type { SearchResult } from '../../lib/ldapActions';
import type { AuthConfig, BranchPermissions } from '../../config/args';
import AuthzBase from '../../lib/authz/base';

interface CachedGroups {
  groups: string[];
  timestamp: number;
}

export default class AuthzPerBranch extends AuthzBase {
  name = 'authzPerBranch';
  authConfig?: AuthConfig;
  groupCache: Map<string, CachedGroups> = new Map();

  constructor(server: DM) {
    super(server);

    // Cache TTL in milliseconds (default: 1 minute, configurable)
    this.cacheTTL = (this.config.authz_per_branch_cache_ttl || 60) * 1000;

    // Load authorization config from config object
    this.authConfig = this.config.authz_per_branch_config;
    if (this.authConfig) {
      this.logger.info('Authorization config loaded');
    }
  }

  /**
   * Resolve user - for authzPerBranch, we use uid directly
   */
  async resolveUser(uid: string): Promise<string | null> {
    return uid;
  }

  /**
   * Override to add authConfig check
   */
  protected shouldSkipAuthorization(req?: any): boolean {
    return !req?.user || !this.authConfig;
  }

  // Note: hooks are inherited from AuthzBase

  /**
   * Get user's permissions for a specific branch
   */
  async getUserPermissions(
    uid: string,
    branch: string
  ): Promise<BranchPermissions> {
    if (!this.authConfig) {
      return { read: true, write: true, delete: true };
    }

    // Start with default permissions
    let permissions: BranchPermissions = {
      read: this.authConfig.default?.read ?? false,
      write: this.authConfig.default?.write ?? false,
      delete: this.authConfig.default?.delete ?? false,
    };

    // Check user-specific permissions
    if (this.authConfig.users?.[uid]) {
      const userPerms = this.findBranchPermissions(
        this.authConfig.users[uid],
        branch
      );
      if (userPerms) {
        permissions = this.mergePermissions(permissions, userPerms);
      }
    }

    // Check group-based permissions
    const userGroups = await this.getUserGroups(uid);
    for (const groupDn of userGroups) {
      if (this.authConfig.groups?.[groupDn]) {
        const groupPerms = this.findBranchPermissions(
          this.authConfig.groups[groupDn],
          branch
        );
        if (groupPerms) {
          permissions = this.mergePermissions(permissions, groupPerms);
        }
      }
    }

    return permissions;
  }

  /**
   * Get list of branches user has read access to (base class implementation)
   */
  async getAuthorizedBranches(uid: string): Promise<string[]> {
    return this.getAuthorizedBranchesForPermission(uid, 'read');
  }

  /**
   * Get list of branches user has access to for a given permission type
   */
  async getAuthorizedBranchesForPermission(
    uid: string,
    permissionType: 'read' | 'write' | 'delete'
  ): Promise<string[]> {
    if (!this.authConfig) {
      return [];
    }

    const branches: string[] = [];

    // Check user-specific permissions
    if (this.authConfig.users?.[uid]) {
      for (const [branch, perms] of Object.entries(
        this.authConfig.users[uid]
      )) {
        if (perms[permissionType]) {
          branches.push(branch);
        }
      }
    }

    // Check group-based permissions
    const userGroups = await this.getUserGroups(uid);
    for (const groupDn of userGroups) {
      if (this.authConfig.groups?.[groupDn]) {
        for (const [branch, perms] of Object.entries(
          this.authConfig.groups[groupDn]
        )) {
          if (perms[permissionType] && !branches.includes(branch)) {
            branches.push(branch);
          }
        }
      }
    }

    return branches;
  }

  /**
   * Find permissions for a branch (supports sub-branch matching)
   */
  private findBranchPermissions(
    branchPerms: { [branch: string]: BranchPermissions },
    targetBranch: string
  ): BranchPermissions | null {
    // Exact match first
    if (branchPerms[targetBranch]) {
      return branchPerms[targetBranch];
    }

    // Check if targetBranch is a sub-branch of any configured branch
    for (const [branch, perms] of Object.entries(branchPerms)) {
      if (targetBranch.toLowerCase().endsWith(`,${branch.toLowerCase()}`)) {
        return perms;
      }
    }

    return null;
  }

  /**
   * Merge permissions (OR logic - grant if any source grants)
   */
  private mergePermissions(
    current: BranchPermissions,
    additional: BranchPermissions
  ): BranchPermissions {
    return {
      read: current.read || additional.read || false,
      write: current.write || additional.write || false,
      delete: current.delete || additional.delete || false,
    };
  }

  /**
   * Build LDAP filter for authorized branches
   */
  private buildBranchFilter(
    baseDn: string,
    authorizedBranches: string[]
  ): string | null {
    // If base DN is within authorized branches, no additional filter needed
    const baseInAuthorized = authorizedBranches.some(
      branch =>
        baseDn.toLowerCase() === branch.toLowerCase() ||
        baseDn.toLowerCase().endsWith(`,${branch.toLowerCase()}`)
    );

    if (baseInAuthorized) {
      return null;
    }

    // Otherwise, restrict to authorized branches
    if (authorizedBranches.length === 1) {
      return `(entryDN=*,${authorizedBranches[0]})`;
    } else if (authorizedBranches.length > 1) {
      const filters = authorizedBranches
        .map(branch => `(entryDN=*,${branch})`)
        .join('');
      return `(|${filters})`;
    }

    return null;
  }

  /**
   * Get user's group memberships with caching
   */
  async getUserGroups(uid: string): Promise<string[]> {
    const now = Date.now();

    // Check cache
    const cached = this.groupCache.get(uid);
    if (cached && now - cached.timestamp < this.cacheTTL) {
      return cached.groups;
    }

    // Resolve groups from LDAP
    const groups: string[] = [];
    try {
      // Search for groups where user is a member, using wildcard pattern
      // This works regardless of where the user DN is located
      const memberAttr = this.config.ldap_group_member_attribute || 'member';
      const filter = `(${memberAttr as string}=${this.config.ldap_user_main_attribute}=${uid},*)`;

      const searchResult = (await this.server.ldap.search(
        {
          paged: false,
          filter,
          attributes: ['dn'],
        },
        this.server.ldap.base
      )) as SearchResult;

      if (searchResult.searchEntries) {
        for (const entry of searchResult.searchEntries) {
          if (entry.dn) {
            groups.push(
              typeof entry.dn === 'string' ? entry.dn : String(entry.dn)
            );
          }
        }
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error(`Failed to resolve groups for user ${uid}: ${err}`);
    }

    // Update cache
    this.groupCache.set(uid, { groups, timestamp: now });

    return groups;
  }
}
