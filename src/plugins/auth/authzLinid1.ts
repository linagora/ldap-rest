/**
 * @module plugins/auth/authzLinid1
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Authorization plugin based on twakeLocalAdminLink LDAP attribute
 * Grants permissions to users referenced in organization's twakeLocalAdminLink
 * @group Plugins
 */
import { FilterParser, SearchFilter } from 'ldapts';
import type { Entry, SearchOptions } from 'ldapts';

import type { DM } from '../../bin/index.js';
import { roleAttribute, type Schema } from '../../config/schema.js';
import type { Hooks, MaybePromise } from '../../hooks.js';
import type {
  AttributesList,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions.js';
import type { BranchPermissions } from '../../config/args.js';
import type { DmRequest } from '../../lib/auth/base.js';
import AuthzBase, { mostSpecificBranchRule } from '../../lib/authz/base.js';
import { AuthzRefusedError } from '../../lib/errors.js';
import { filterAttributeKey } from '../../lib/ldapFilter.js';
import {
  escapeLdapFilter,
  isDnInBranch,
  isDummyMemberDn,
  normalizeDn,
  organizationLink,
} from '../../lib/utils.js';

interface CachedPermissions {
  branches: Map<string, BranchPermissions>;
  timestamp: number;
}

/** The filter names that test a group's member or owner values. */
type ReducedFilterNames = Set<string>;

/**
 * Whether one of a caller's written branches lies in a delegated
 * organization, or is one.
 */
function delegationsIntersect(
  branches: string[],
  delegations: string[]
): boolean {
  const within = (dn: string, branch: string): boolean => {
    try {
      return isDnInBranch(dn, branch);
    } catch {
      return false;
    }
  };
  return delegations.some(delegation =>
    branches.some(branch => within(branch, delegation))
  );
}

/** The node fields the filter guard reads. */
interface FilterNode {
  type?: number;
  attribute?: string;
  matchType?: string;
  value?: unknown;
  initial?: unknown;
  any?: unknown;
  final?: unknown;
  filters?: unknown[];
  filter?: unknown;
}

/** Whether a leaf tests a value the group's delegation would hide. */
function testsReduced(node: FilterNode, names: ReducedFilterNames): boolean {
  if (typeof node.attribute === 'string' && node.attribute.length > 0)
    return names.has(filterAttributeKey(node.attribute));
  // An extensible match keeps its attribute in `matchType`; an empty one
  // runs over every attribute and may test a hidden member whatever its
  // matching rule.
  if (typeof node.matchType === 'string' && node.matchType.length > 0)
    return names.has(filterAttributeKey(node.matchType));
  if (node.type === SearchFilter.extensibleMatch) return true;
  return false;
}

/** Whether any test of a parsed filter names a reduced value. */
function filterTouchesReduced(
  filter: unknown,
  names: ReducedFilterNames
): boolean {
  const node = filter as FilterNode | undefined;
  if (!node) return false;
  if (node.type === SearchFilter.and || node.type === SearchFilter.or)
    return (node.filters ?? []).some(child =>
      filterTouchesReduced(child, names)
    );
  if (node.type === SearchFilter.not)
    return filterTouchesReduced(node.filter, names);
  return testsReduced(node, names);
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

  /** The delegation attribute, when the feature is on. */
  private readonly groupAdminAttr: string;
  private readonly adminAttr: string;
  private reducedFilterNames?: Promise<ReducedFilterNames>;

  /**
   * Marks a search whose projection we widened for the delegation attribute.
   * As in the base class, a symbol survives the copies another plugin makes.
   */
  private static readonly widenedForDelegation = Symbol(
    'widened for the group delegation'
  );

  declare hooks: AuthzBase['hooks'] &
    Pick<
      Hooks,
      | 'ldapmodifydone'
      | 'ldapdeletedone'
      | 'ldaprenamedone'
      | 'ldapsearchrequest'
      | 'ldapsearchfilter'
      | 'ldapmodifyrequest'
    >;

  /** What the classes above declared, read once this one is constructed */
  private readonly declaredByBase: Hooks;

  constructor(server: DM) {
    super(server);
    this.declaredByBase = { ...this.hooks };

    this.cacheTTL = this.options(linid1Options).authz_linid1_cache_ttl * 1000;

    this.adminAttr = this.options(linid1Options).authz_local_admin_attribute;
    this.groupAdminAttr =
      this.options(linid1Options).authz_group_admin_attribute;
    this.logger.info(
      `AuthzLinid1: Authorization based on ${this.adminAttr} attribute enabled`
    );
    if (this.groupAdminAttr)
      this.logger.info(
        `AuthzLinid1: group membership delegated through the ` +
          `${this.groupAdminAttr} attribute`
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
    const watched = [this.adminAttr];
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
      ldapsearchrequest: (
        args
      ): MaybePromise<[string, SearchOptions, DmRequest?]> =>
        this.widenForDelegation(args),
      ldapsearchfilter: (
        args
      ): MaybePromise<[SearchResult, DmRequest?, SearchOptions?]> =>
        this.filterDelegatedGroups(args),
      ldapmodifyrequest: (
        args
      ): MaybePromise<[string, ModifyRequest, number, DmRequest?]> =>
        this.judgeDelegatedGroup(args),
      ldapmodifydone: (dn, changes, op, context): MaybePromise<void> => {
        if (touches(changes, watched)) this.forgetPermissions();
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
   * Add the delegation attribute to a search projection the caller did not
   * ask it in: the filter below cannot tell a delegated group from any other
   * entry without it. It is removed again once the result is judged.
   */
  private async widenForDelegation([base, opts, req]: [
    string,
    SearchOptions,
    DmRequest?,
  ]): Promise<[string, SearchOptions, DmRequest?]> {
    const [judgedBase, initialOpts, judgedReq] = (await this.declaredByBase
      .ldapsearchrequest!([base, opts, req])) as [
      string,
      SearchOptions,
      DmRequest?,
    ];
    const attr = this.groupAdminAttr;
    if (!attr || this.shouldSkipAuthorization(req))
      return [judgedBase, initialOpts, judgedReq];

    let judgedOpts = initialOpts;
    if (!AuthzBase.wantsAttribute(judgedOpts, attr)) {
      const value = judgedOpts.attributes;
      const asked = Array.isArray(value) ? value.map(String) : [String(value)];
      judgedOpts = {
        ...judgedOpts,
        attributes: [...asked, attr],
        [AuthzLinid1.widenedForDelegation]: true,
      } as SearchOptions;
    }
    return [judgedBase, judgedOpts, judgedReq];
  }

  /**
   * Keep a delegated group the attachment filter would hide, and show only
   * the members of it this caller manages. A group the caller administers
   * through its organization keeps the ordinary answer, members included:
   * the delegation is an addition to that path, not a restriction on it.
   */
  private async filterDelegatedGroups([result, req, opts]: [
    SearchResult,
    DmRequest?,
    SearchOptions?,
  ]): Promise<[SearchResult, DmRequest?, SearchOptions?]> {
    const baseFilter = this.declaredByBase.ldapsearchfilter!;
    const passThrough = async (): Promise<
      [SearchResult, DmRequest?, SearchOptions?]
    > => {
      const filtered = (await baseFilter([result, req, opts])) as [
        SearchResult,
        DmRequest?,
        SearchOptions?,
      ];
      this.stripWidened(filtered[0], filtered[2]);
      return filtered;
    };
    const attr = this.groupAdminAttr;
    if (!attr || !result?.searchEntries?.length) return passThrough();
    if (this.shouldSkipAuthorization(req)) return passThrough();
    const user = await this.resolveCaller(req!);
    if (!user) return passThrough();

    // Read before the base filter: it mutates the entries it judges, and a
    // group it drops is one we may have to put back.
    const delegated = new Map<string, Entry>();
    for (const entry of result.searchEntries) {
      const dn = String(entry.dn);
      if (this.isGlobalBranch(dn)) continue;
      if (this.delegationsOf(entry, attr).length === 0) continue;
      delegated.set(this.dnKey(dn), entry);
    }

    const filtered = (await baseFilter([result, req, opts])) as [
      SearchResult,
      DmRequest?,
      SearchOptions?,
    ];
    const [kept, , keptOpts] = filtered;
    if (delegated.size > 0) {
      const entries = kept.searchEntries ?? [];
      const keptDns = new Set(
        entries.map(entry => this.dnKey(String(entry.dn)))
      );
      const reducedNames = await this.memberFilterNames();
      let touchesReduced = false;
      if (opts?.filter) {
        try {
          touchesReduced = filterTouchesReduced(
            FilterParser.parseString(String(opts.filter)),
            reducedNames
          );
        } catch {
          // A filter this cannot read is not judged against the trimmed
          // group: keeping the group out is safer than guessing.
          touchesReduced = true;
        }
      }
      const linkAttr = this.config.ldap_organization_link_attribute;
      const widenedLink = (opts as { [key: symbol]: unknown } | undefined)?.[
        AuthzBase.widenedForLink
      ];
      const widenedObjectClass = (
        opts as { [key: symbol]: unknown } | undefined
      )?.[AuthzBase.widenedForObjectClass];
      const branches = await this.getAuthorizedBranches(user);
      const memberOrganization = new Map<string, Promise<string | undefined>>();
      const organizationOf = (dn: string): Promise<string | undefined> => {
        const key = this.dnKey(dn);
        let found = memberOrganization.get(key);
        if (!found) {
          found = this.storedOrganization(dn);
          memberOrganization.set(key, found);
        }
        return found;
      };
      const manages = async (
        dn: string,
        delegations: string[]
      ): Promise<boolean> => {
        const organization = await organizationOf(dn);
        if (!organization) return false;
        if (!this.withinDelegation(organization, delegations)) return false;
        return (
          (await this.getUserPermissions(user, organization)).write === true
        );
      };

      for (const [key, entry] of delegated) {
        if (keptDns.has(key) || touchesReduced) continue;
        const delegations = this.delegationsOf(entry, attr);
        if (!delegationsIntersect(branches, delegations)) continue;
        const copy = { ...entry };
        await this.keepManagedMembers(copy, delegations, manages);
        if (widenedLink && linkAttr) delete copy[linkAttr];
        if (widenedObjectClass) delete copy.objectClass;
        entries.push(copy);
      }
      kept.searchEntries = entries;
    }

    this.stripWidened(kept, keptOpts);

    return filtered;
  }

  /** Remove the delegation attribute a search only carried for this judgement. */
  private stripWidened(result: SearchResult, opts?: SearchOptions): void {
    const marked = opts as { [key: symbol]: unknown } | undefined;
    const groupAttr = marked?.[AuthzLinid1.widenedForDelegation]
      ? this.groupAdminAttr
      : undefined;
    if (!groupAttr) return;
    for (const entry of result.searchEntries ?? []) delete entry[groupAttr];
  }

  /**
   * Judge a change to a group whose membership is delegated: a delegated
   * administrator may add or remove members they manage, and change nothing
   * else on the group.
   *
   * An ordinary administrator of the group goes through the base checks
   * untouched, as does a caller the delegation does not reach.
   */
  private async judgeDelegatedGroup([dn, changes, op, req]: [
    string,
    ModifyRequest,
    number,
    DmRequest?,
  ]): Promise<[string, ModifyRequest, number, DmRequest?]> {
    const baseModify = this.declaredByBase.ldapmodifyrequest!;
    const attr = this.groupAdminAttr;
    if (!attr || this.shouldSkipAuthorization(req))
      return (await baseModify([dn, changes, op, req])) as [
        string,
        ModifyRequest,
        number,
        DmRequest?,
      ];
    const user = await this.resolveCaller(req!);
    if (!user)
      return (await baseModify([dn, changes, op, req])) as [
        string,
        ModifyRequest,
        number,
        DmRequest?,
      ];

    const judged = await this.storedDn(dn);
    if (this.isGlobalBranch(judged))
      return (await baseModify([dn, changes, op, req])) as [
        string,
        ModifyRequest,
        number,
        DmRequest?,
      ];
    const group = await this.storedGroup(judged, attr);
    if (!group || group.delegations.length === 0)
      return (await baseModify([dn, changes, op, req])) as [
        string,
        ModifyRequest,
        number,
        DmRequest?,
      ];

    const linkAttr = this.config.ldap_organization_link_attribute;
    const branch =
      (linkAttr ? organizationLink(group.entry[linkAttr]) : undefined) ??
      this.extractBranchDn(judged);
    // The group's own administrators keep every right they had
    if ((await this.getUserPermissions(user, branch)).write)
      return (await baseModify([dn, changes, op, req])) as [
        string,
        ModifyRequest,
        number,
        DmRequest?,
      ];

    const branches = await this.getAuthorizedBranches(user);
    if (!delegationsIntersect(branches, group.delegations))
      return (await baseModify([dn, changes, op, req])) as [
        string,
        ModifyRequest,
        number,
        DmRequest?,
      ];

    await this.assertDelegatedChanges(user, group.delegations, changes, judged);
    return [dn, changes, op, req];
  }

  /** The fields a group schema gives its members and owners. */
  private groupAttributes(): { members: string; owners: string } {
    const groups = this.server.loadedPlugins['ldapGroups'] as
      { schema?: Schema } | undefined;
    return {
      members: roleAttribute(groups?.schema, 'members') || 'member',
      owners: roleAttribute(groups?.schema, 'owners') || 'owner',
    };
  }

  /**
   * The filter names that test the member and owner values we reduce: their
   * own names and OIDs, and every supertype they answer under. A filter on
   * `distinguishedName`, which both inherit, tests both.
   */
  private memberFilterNames(): Promise<ReducedFilterNames> {
    this.reducedFilterNames ??= this.resolveMemberFilterNames();
    return this.reducedFilterNames;
  }

  private async resolveMemberFilterNames(): Promise<ReducedFilterNames> {
    const { members, owners } = this.groupAttributes();
    const names = new Set<string>();
    const add = (name: string): void => {
      const key = filterAttributeKey(name);
      if (key) names.add(key);
    };
    for (const attribute of [members, owners]) add(attribute);
    // Both are distinguishedName subtypes; the common case needs no schema
    add('distinguishedName');

    try {
      const index = await this.server.ldap.schemaIndex();
      for (const attribute of [members, owners]) {
        let current = index.getAttributeType(attribute);
        const seen = new Set<string>();
        while (current && !seen.has(current.oid)) {
          seen.add(current.oid);
          add(current.oid);
          for (const name of current.names) add(name);
          current = current.sup
            ? index.getAttributeType(current.sup)
            : undefined;
        }
      }
    } catch (err) {
      // Retry on the next request rather than keep a failure for the life of
      // the process: the configured names still answer the common case.
      this.reducedFilterNames = undefined;
      this.logger.debug(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `AuthzLinid1: could not resolve member attribute types: ${err}`
      );
    }

    return names;
  }

  /** Whether `dn` is in a branch only its organization's administrators read. */
  private isGlobalBranch(dn: string): boolean {
    return this.globalBranches().some(branch => this.within(dn, branch));
  }

  /**
   * Keep only the members and owners this caller manages, in place.
   *
   * @param entry group entry about to be answered
   * @param delegations the organizations the group delegates to
   * @param manages tells whether a member's organization is one of them
   */
  private async keepManagedMembers(
    entry: AttributesList,
    delegations: string[],
    manages: (dn: string, delegations: string[]) => Promise<boolean>
  ): Promise<void> {
    const { members, owners } = this.groupAttributes();
    for (const attr of new Set([members, owners])) {
      const value = entry[attr];
      if (value === undefined || value === null) continue;
      const kept: string[] = [];
      for (const dn of (Array.isArray(value) ? value : [value]).map(String))
        if (await manages(dn, delegations)) kept.push(dn);
      entry[attr] = kept;
    }
  }

  /** The organizations a group delegates membership management to. */
  private delegationsOf(entry: AttributesList, attr: string): string[] {
    const value = entry[attr];
    if (value === undefined || value === null) return [];
    return (Array.isArray(value) ? value : [value])
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  /** Whether a member's organization lies in one of the delegated branches. */
  private withinDelegation(dn: string, delegations: string[]): boolean {
    return delegations.some(branch => this.within(dn, branch));
  }

  /** The organization a member is attached to, and nothing else. */
  private async storedOrganization(dn: string): Promise<string | undefined> {
    const linkAttr = this.config.ldap_organization_link_attribute;
    if (!linkAttr) return undefined;
    try {
      // As the server: the judgement's own read: as the caller, it would be judged by itself
      const result = (await this.server.ldap.system.search(
        { paged: false, scope: 'base', attributes: [linkAttr] },
        dn
      )) as SearchResult;
      return organizationLink(result.searchEntries?.[0]?.[linkAttr]);
    } catch {
      return undefined;
    }
  }

  /** The delegation of a group, and its stored entry. */
  private async storedGroup(
    dn: string,
    attr: string
  ): Promise<{ entry: AttributesList; delegations: string[] } | undefined> {
    const linkAttr = this.config.ldap_organization_link_attribute;
    const attributes = ['dn', attr, ...(linkAttr ? [linkAttr] : [])];
    try {
      const result = (await this.server.ldap.system.search(
        { paged: false, scope: 'base', attributes },
        dn
      )) as SearchResult;
      const entry = result.searchEntries?.[0];
      if (!entry) return undefined;
      return { entry, delegations: this.delegationsOf(entry, attr) };
    } catch {
      return undefined;
    }
  }

  /** A DN as a key two spellings of it share. */
  private dnKey(dn: string): string {
    try {
      return normalizeDn(dn);
    } catch {
      return dn.toLowerCase();
    }
  }

  /** `isDnInBranch`, with a malformed DN judged as outside. */
  private within(dn: string, branch: string): boolean {
    try {
      return isDnInBranch(dn, branch);
    } catch {
      return false;
    }
  }

  /**
   * Refuse a delegated change that is not an add or delete of a member the
   * caller manages.
   */
  private async assertDelegatedChanges(
    user: string,
    delegations: string[],
    changes: ModifyRequest,
    groupDn: string
  ): Promise<void> {
    const { members } = this.groupAttributes();
    const same = (name: string): boolean =>
      name.split(';')[0].toLowerCase() === members.toLowerCase();
    const refuse = (what: string): never => {
      throw new AuthzRefusedError(
        `User ${user} may only add or remove members of ${groupDn}, not ${what}`
      );
    };

    if (changes.replace && Object.keys(changes.replace).length > 0)
      refuse('replace an attribute');
    if (changes.add)
      for (const name of Object.keys(changes.add))
        if (!same(name)) refuse(name);
    if (Array.isArray(changes.delete)) {
      if (changes.delete.length > 0) refuse(`delete ${changes.delete[0]}`);
    } else if (changes.delete) {
      for (const name of Object.keys(changes.delete))
        if (!same(name)) refuse(name);
    }

    const values = (part: AttributesList | undefined): string[] | undefined => {
      if (!part) return undefined;
      const key = Object.keys(part).find(name => same(name));
      if (key === undefined) return undefined;
      const value = part[key];
      return (Array.isArray(value) ? value : [value]).map(item => String(item));
    };
    // An empty list deletes the whole attribute in LDAP: it names no value
    // to judge, and would clear every member, not just the caller's.
    const added = values(changes.add);
    const deleted = Array.isArray(changes.delete)
      ? undefined
      : values(changes.delete);
    if (added && added.length === 0) refuse('add no member');
    if (deleted && deleted.length === 0) refuse('delete every member');
    for (const value of [...(added ?? []), ...(deleted ?? [])]) {
      if (this.isDummyMember(value)) continue;
      if (await this.managesMember(user, delegations, value)) continue;
      throw new AuthzRefusedError(
        `User ${user} may not manage member ${value} of ${groupDn}`
      );
    }
  }

  /** Whether the caller manages a member: it is attached to one of theirs. */
  private async managesMember(
    user: string,
    delegations: string[],
    dn: string
  ): Promise<boolean> {
    const organization = await this.storedOrganization(dn);
    if (!organization) return false;
    if (!this.withinDelegation(organization, delegations)) return false;
    return (await this.getUserPermissions(user, organization)).write === true;
  }

  /** The group plugin's placeholder, which takes the last member's place. */
  private isDummyMember(dn: string): boolean {
    return isDummyMemberDn(dn, this.config.group_dummy_user);
  }

  /**
   * The groups a caller manages the members of through a delegation, for
   * `GET /authz/scope`. Read on each call: a group's delegation is a handful
   * of entries, and the scope is not on a request's hot path.
   *
   * @param user the caller's DN
   * @returns the delegated groups, empty when the option is off
   */
  async delegatedGroups(
    user: string
  ): Promise<{ dn: string; manageMembers: boolean }[]> {
    const attr = this.groupAdminAttr;
    const base = (
      this.server.loadedPlugins['ldapGroups'] as { base?: string } | undefined
    )?.base;
    if (!attr || !base) return [];
    const branches = await this.getAuthorizedBranches(user);
    if (branches.length === 0) return [];
    try {
      // As the server: the scope describes what the caller's own rules grant
      const result = (await this.server.ldap.system.search(
        {
          paged: false,
          scope: 'sub',
          filter: `(${attr}=*)`,
          attributes: ['dn', attr],
        },
        base
      )) as SearchResult;
      const groups: { dn: string; manageMembers: boolean }[] = [];
      for (const entry of result.searchEntries ?? []) {
        const dn = String(entry.dn);
        if (this.isGlobalBranch(dn)) continue;
        if (delegationsIntersect(branches, this.delegationsOf(entry, attr)))
          groups.push({ dn, manageMembers: true });
      }
      return groups;
    } catch (err) {
      this.logger.error(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `AuthzLinid1: could not read delegated groups: ${err}`
      );
      return [];
    }
  }

  /**
   * The organizations naming `dn` an administrator. Taking one of those
   * accounts over grants its branches, so the base refuses a caller who
   * does not hold them all.
   */
  protected async administeredBranches(dn: string): Promise<string[]> {
    const orgBase =
      this.config.ldap_top_organization || this.config.ldap_base || '';
    if (!orgBase) return [];
    const result = (await this.server.ldap.system.search(
      {
        paged: false,
        filter: `(${this.adminAttr}=${escapeLdapFilter(dn)})`,
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
      const filter = `(${this.adminAttr}=${escapeLdapFilter(userDn)})`;
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
