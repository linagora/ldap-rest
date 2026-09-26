/**
 * @module plugins/auth/authzPerBranch
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Authorization plugin that restricts LDAP access by branch
 * Supports user and group-based permissions with configurable defaults
 * @group Plugins
 */
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type { ModifyRequest, SearchResult } from '../../lib/ldapActions';
import type { AuthConfig, BranchPermissions } from '../../config/args';
import type { DmRequest } from '../../lib/auth/base';
import AuthzBase from '../../lib/authz/base';
import { AmbiguousIdentityError } from '../../lib/errors';
import { escapeLdapFilter, normalizeDn } from '../../lib/utils';
import { warnUnmatchedRuleKeys } from '../../lib/auth/base';

interface CachedGroups {
  groups: string[];
  timestamp: number;
}

type GroupRules = NonNullable<AuthConfig['groups']>[string];

export default class AuthzPerBranch extends AuthzBase {
  name = 'authzPerBranch';
  authConfig?: AuthConfig;
  groupCache: Map<string, CachedGroups> = new Map();
  /** Lookups under way, so concurrent misses for one uid share a search. */
  private pendingGroups = new Map<string, Promise<string[]>>();
  /**
   * Bumped by every invalidation. A lookup that started before a write may
   * have read the directory before it: it still answers its own callers,
   * but does not put what it read back into the cache.
   */
  private groupGeneration = 0;
  /** `authConfig.groups` keyed by normalized DN, and the object it was built from. */
  private groupRulesIndex?: {
    source: AuthConfig['groups'];
    rules: Map<string, GroupRules>;
  };

  declare hooks: AuthzBase['hooks'] &
    Pick<Hooks, 'ldapadddone' | 'ldapmodifydone' | 'ldapdeletedone'>;

  constructor(server: DM) {
    super(server);

    // Cache TTL in milliseconds (default: 1 minute, configurable)
    this.cacheTTL = (this.config.authz_per_branch_cache_ttl || 60) * 1000;

    // Load authorization config from config object
    this.authConfig = this.config.authz_per_branch_config;
    if (this.authConfig) {
      this.logger.info('Authorization config loaded');
    }

    // Group memberships are cached per uid, and a write can change one: a
    // `member` added or removed, a user deleted, renamed or given another
    // uid, or a second entry carrying the same uid. Such a write drops the
    // whole map, as the base does on a rename: a few lookups are cheaper
    // than working out which uid a change affects, and without it a caller
    // removed from a group kept its grants until the TTL ran out.
    //
    // A modify is the one write that says what it touched, and the most
    // frequent one: it only drops the map when it touches the member
    // attribute or the one users are found by. Adds are not filtered — an
    // added user always carries that attribute, and may duplicate a uid.
    // Registered from the constructor because the server reads `hooks` once
    // the plugin is built; the base's own rename hook keeps running.
    const inherited = this.hooks;
    const forget = (): void => this.forgetGroups();
    this.hooks = {
      ...inherited,
      ldapadddone: forget,
      ldapmodifydone: ([, changes]): void => {
        if (this.touchesMembership(changes)) forget();
      },
      ldapdeletedone: forget,
      ldaprenamedone: (): void => {
        inherited.ldaprenamedone();
        forget();
      },
    };
  }

  /**
   * Whether a modify can change which groups a uid belongs to: it touches
   * the member attribute, or the attribute a uid is resolved by.
   */
  private touchesMembership(changes: ModifyRequest): boolean {
    const watched = [
      (this.config.ldap_group_member_attribute as string) || 'member',
      this.config.ldap_user_main_attribute || 'uid',
    ].map(a => a.toLowerCase());
    const touched = [
      ...Object.keys(changes.add ?? {}),
      ...Object.keys(changes.replace ?? {}),
      ...(Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete ?? {})),
    ];
    // `member;range=…` and the like name the same attribute.
    return touched.some(attr =>
      watched.includes(attr.split(';')[0].toLowerCase())
    );
  }

  /** Drop every cached and pending group lookup. */
  forgetGroups(): void {
    this.groupGeneration++;
    this.groupCache.clear();
    this.pendingGroups.clear();
  }

  /**
   * Resolve user - for authzPerBranch, we use uid directly
   */
  resolveUser(uid: string): Promise<string | null> {
    return Promise.resolve(uid);
  }

  /**
   * Say, once every plugin is loaded, when no configured user can ever be
   * the caller.
   *
   * A `authz_per_branch_config.users` key is an identity, and which values
   * an authenticator publishes differs per plugin: keys written for token
   * names are inert behind OpenID Connect, where the identity is a `sub`.
   * The permissions then fall back to `default`, which reads as a
   * configuration that is working.
   */
  afterLoad(): void {
    warnUnmatchedRuleKeys(
      Object.keys(this.authConfig?.users ?? {}),
      this.server.loadedPlugins,
      this.name,
      this.logger
    );
  }

  /**
   * Override to add authConfig check
   */
  protected shouldSkipAuthorization(req?: DmRequest): boolean {
    return super.shouldSkipAuthorization(req) || !this.authConfig;
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
      const rules = this.groupRules(groupDn);
      if (rules) {
        const groupPerms = this.findBranchPermissions(rules, branch);
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
      const rules = this.groupRules(groupDn);
      if (rules) {
        for (const [branch, perms] of Object.entries(rules)) {
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
   * The rules configured for a group, compared as DNs.
   *
   * The directory answers with its own spelling of a group's DN, and the
   * configuration carries whatever an administrator typed: a textual lookup
   * missed `cn=Admins,ou=Groups,…` against `cn=admins, ou=groups,…` and
   * dropped the rule without a word. The index is rebuilt whenever
   * `authConfig.groups` is replaced.
   */
  private groupRules(groupDn: string): GroupRules | undefined {
    const source = this.authConfig?.groups;
    if (!source) return undefined;
    if (this.groupRulesIndex?.source !== source) {
      const rules = new Map<string, GroupRules>();
      for (const [dn, perms] of Object.entries(source)) {
        let key: string;
        try {
          key = normalizeDn(dn);
        } catch {
          this.logger.warn(
            `${this.name}: group "${dn}" is not a valid DN, compared as text`
          );
          key = dn.toLowerCase();
        }
        if (rules.has(key))
          this.logger.warn(
            `${this.name}: several groups entries name ${key}; only the last one applies`
          );
        rules.set(key, perms);
      }
      this.groupRulesIndex = { source, rules };
    }
    let key: string;
    try {
      key = normalizeDn(groupDn);
    } catch {
      key = groupDn.toLowerCase();
    }
    return this.groupRulesIndex.rules.get(key);
  }

  /**
   * Get user's group memberships with caching
   *
   * Concurrent misses for one uid share a single lookup. What the lookup
   * found is cached, including "no group"; a failed search is not, so an
   * outage does not outlive itself by a TTL.
   */
  async getUserGroups(uid: string): Promise<string[]> {
    const now = Date.now();

    // Check cache
    const cached = this.groupCache.get(uid);
    if (cached && now - cached.timestamp < this.cacheTTL) {
      return cached.groups;
    }

    const inFlight = this.pendingGroups.get(uid);
    if (inFlight) return inFlight;

    const generation = this.groupGeneration;
    const lookup = this.lookupGroups(uid)
      .then(groups => {
        if (generation === this.groupGeneration)
          this.groupCache.set(uid, { groups, timestamp: Date.now() });
        return groups;
      })
      .finally(() => {
        if (this.pendingGroups.get(uid) === lookup)
          this.pendingGroups.delete(uid);
      });
    this.pendingGroups.set(uid, lookup);
    return lookup;
  }

  /** Read a uid's group memberships from the directory. */
  private async lookupGroups(uid: string): Promise<string[]> {
    // The member attribute holds DNs, whose matching rule has no substring
    // form: the uid has to be resolved to its DN before the search.
    let userDn: string | null;
    try {
      userDn = await this.findUserDn(uid);
    } catch (err) {
      if (!(err instanceof AmbiguousIdentityError)) throw err;
      // The `users` rules are keyed on the uid itself and stay usable; only
      // the groups, which belong to one entry or the other, are withheld.
      this.logger.warn(
        `${this.name}: ${uid} names ${err.count} directory entries, so no group rule applies to them`
      );
      return [];
    }
    if (!userDn) return [];

    const memberAttr = this.config.ldap_group_member_attribute || 'member';
    const filter = `(${memberAttr as string}=${escapeLdapFilter(userDn)})`;
    const searchResult = (await this.server.ldap.search(
      {
        paged: false,
        filter,
        attributes: ['dn'],
      },
      this.server.ldap.base
    )) as SearchResult;

    const groups: string[] = [];
    for (const entry of searchResult.searchEntries ?? []) {
      if (entry.dn) {
        groups.push(typeof entry.dn === 'string' ? entry.dn : String(entry.dn));
      }
    }
    return groups;
  }
}
