/**
 * @module lib/authz/base
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Base class for authorization plugins
 * Provides common functionality for permission-based access control
 * @group Libraries
 */
import type { SearchOptions } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { BranchPermissions } from '../../config/args';
import { assertIdentityMode, identityFor, type DmRequest } from '../auth/base';
import type {
  AttributesList,
  ModifyRequest,
  SearchResult,
  AttributeValue,
} from '../ldapActions';
import { AmbiguousIdentityError, ForbiddenError } from '../errors';
import { escapeLdapFilter, getParentDn, isDnInBranch } from '../utils';

import { authzFor, servesRequest } from './composition';

/**
 * Abstract base class for authorization plugins
 * Provides common utility methods and interface for LDAP-based authorization
 */
export default abstract class AuthzBase extends DmPlugin {
  /**
   * Searches whose projection we widened to carry the organization link.
   *
   * The filter cannot ask `opts` whether the caller wanted the attribute: by
   * then `opts` is the widened one and would answer yes about an attribute
   * we added ourselves. Holding the objects we touched keeps the question
   * answerable, and a WeakSet lets them be collected with the request.
   */
  private static widenedForLink = new WeakSet<object>();

  roles: Role[] = ['authz'] as const;
  cacheTTL!: number;

  /** What `--authz-unresolved-user` accepts. */
  private static readonly UNRESOLVED_POLICIES = ['deny', 'allow'] as const;

  /**
   * @param server DM object
   */
  constructor(server: DM) {
    super(server);
    // Refused here rather than read leniently at request time: the option
    // decides whether an identity the model cannot place is refused, and
    // `Allow`, `true` or a trailing space would all have meant `deny` in
    // silence — 403s for everyone, with nothing saying the value was not
    // understood.
    assertIdentityMode(this.config, this.constructor.name);
    // Its shape here, its names once the authenticators are loaded
    // (`assertAuthzComposition`).
    authzFor(this.config, this.constructor.name);
    const policy = (this.config.authz_unresolved_user as string) ?? 'deny';
    if (
      !(AuthzBase.UNRESOLVED_POLICIES as readonly string[]).includes(policy)
    ) {
      throw new Error(
        `${this.constructor.name}: unknown --authz-unresolved-user ` +
          `"${policy}". Known: ${AuthzBase.UNRESOLVED_POLICIES.join(', ')}.`
      );
    }
  }

  /**
   * Whether a search asked for this attribute.
   *
   * No projection at all means every user attribute, and so does `*`. `+`
   * does not: it asks for the operational attributes, and the organization
   * link is a user attribute — a search for `+` alone comes back without it,
   * which is the very case the filter cannot judge, since an entry that
   * arrived without its link looks attached to nothing.
   */
  protected static wantsAttribute(
    opts: SearchOptions | undefined,
    attr: string
  ): boolean {
    const asked = opts?.attributes;
    if (asked === undefined) return true;
    const list = (Array.isArray(asked) ? asked : [asked]).map(a =>
      String(a).toLowerCase()
    );
    if (list.length === 0) return true;
    if (list.includes('*')) return true;
    return list.includes(attr.toLowerCase());
  }

  /**
   * Extract the branch DN to check permissions against
   * For a DN like "uid=user,ou=users,ou=org,dc=example,dc=com"
   * we need to check permissions on the parent branch
   *
   * Handles escaped commas in DN values (e.g., "cn=Smith\, John")
   */
  extractBranchDn(dn: string): string {
    return getParentDn(dn);
  }

  /**
   * The branch a write is judged against.
   *
   * An account is stored in the same `ou=users` as everyone else, so its
   * parent says nothing about who may touch it: what governs it is the
   * organization it is attached to, which is read from the stored entry. An
   * entry attached nowhere falls back to its parent, which is what an
   * organization or a nomenclature value wants.
   *
   * Creation is not routed through here on purpose: `ldapaddrequest` reads
   * the link off the entry being written and is not behind the flag, so
   * unifying the two would judge an add on `ou=users` whenever the flag is
   * off — a relaxation in the default configuration.
   */
  protected async effectiveBranch(dn: string): Promise<string> {
    const linkAttr = this.config.ldap_organization_link_attribute;
    if (!linkAttr || !this.config.authz_filter_attached_entries)
      return this.extractBranchDn(dn);

    const first = (v: AttributeValue | undefined): string | undefined => {
      if (v === undefined || v === null) return undefined;
      const one = Array.isArray(v) ? v[0] : v;
      const str = String(one);
      return str.length > 0 ? str : undefined;
    };

    try {
      const res = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: [linkAttr] },
        dn
      )) as SearchResult;
      const stored = first(
        res.searchEntries?.[0]?.[linkAttr] as AttributeValue
      );
      if (stored) return stored;
    } catch {
      // Unreadable or absent: fall back to the parent, which is what an
      // entry with no organization of its own is judged on anyway.
    }
    return this.extractBranchDn(dn);
  }

  /**
   * The DN of the entry an identity names, or null when none does.
   *
   * Searched under `server.ldap.base`, the base every other search uses: it
   * is `--ldap-base` when set and derived from `--ldap-dn` otherwise, where
   * `config.ldap_base` would be empty and the search would start from the
   * root DSE, which OpenLDAP answers with nothing.
   *
   * More than one entry is a refusal, not a pick: which one comes first is
   * the server's business, and differs between replicas. A failed search
   * propagates rather than reading as "no such user", so a caller that
   * caches the answer does not cache an outage as a fact.
   *
   * @throws AmbiguousIdentityError when several entries carry the identity
   */
  protected async findUserDn(uid: string): Promise<string | null> {
    const filter = `(${this.config.ldap_user_main_attribute || 'uid'}=${escapeLdapFilter(uid)})`;
    const result = (await this.server.ldap.search(
      {
        paged: false,
        filter,
        attributes: ['dn'],
        scope: 'sub',
      },
      this.server.ldap.base
    )) as SearchResult;
    const entries = result.searchEntries ?? [];
    if (entries.length > 1)
      throw new AmbiguousIdentityError(uid, entries.length);
    if (entries.length === 0) return null;
    const dn = entries[0].dn;
    return typeof dn === 'string' ? dn : String(dn);
  }

  /**
   * Resolve user identifier to the format expected by getUserPermissions
   * This allows different implementations:
   * - authzLinid1: converts uid to userDn via LDAP
   * - authzPerBranch: uses uid directly
   *
   * Returns null if user cannot be resolved (will skip authorization)
   */
  abstract resolveUser(uid: string): Promise<string | null>;

  /**
   * Get user's permissions for a specific branch
   * Must be implemented by subclasses
   */
  abstract getUserPermissions(
    user: string,
    branch: string
  ): Promise<BranchPermissions>;

  /**
   * Get list of branches user has access to (for read permission by default)
   * Must be implemented by subclasses
   */
  abstract getAuthorizedBranches(user: string): Promise<string[]>;

  /**
   * Whether this request is none of this plugin's business.
   *
   * Two cases, and only two: a request with no identity (anonymous, skipped
   * by design), and one that authentication plugins outside `--authz-for`
   * vouched for — another population, judged by another model. An identity
   * of *this* population that does not resolve is not skipped here: that is
   * a configuration error, and `resolveCaller` refuses it. Inferring "not
   * mine" from "cannot place it" is exactly the confusion this keeps apart.
   *
   * Subclasses overriding it must call this one.
   */
  protected shouldSkipAuthorization(req?: DmRequest): boolean {
    return !req?.user || !servesRequest(req, this.config);
  }

  /** What `resolveUser` answered for an identity, and when. */
  private resolutionCache = new Map<
    string,
    { user: string | null; at: number }
  >();
  /** How many identities to remember at once. A cap, not a threshold. */
  private static readonly RESOLUTION_CACHE_MAX = 10000;
  /** Said once, when the cap is reached: a log line per request helps nobody. */
  private resolutionCacheFullWarned = false;

  /**
   * Resolve the caller, or say what an identity that does not resolve means.
   *
   * `shouldSkipAuthorization` covers the request that carries no identity at
   * all — anonymous, and skipped by design. This covers the other case: a
   * request that *was* authenticated, whose identity this plugin's model
   * cannot place.
   *
   * That used to return the operation untouched behind a `warn`, which made
   * a configuration mismatch an open door rather than a refusal.
   * `authzLinid1` resolves `req.user` by searching
   * `(<ldap_user_main_attribute>=<identity>)`, so an authenticator
   * publishing anything else — `core/auth/openidconnect` publishes the OIDC
   * `sub`, `core/auth/llng` whatever `whatToTrace` traces — resolved to
   * nothing on every request, and read, write and delete went through
   * across the whole tree, with a line a `notice` production log does not
   * show. (`authzPerBranch` fails the other way: the identity is its own key,
   * so a mismatch yields all-false permissions and a refusal.)
   *
   * An authenticated identity that does not resolve is a failure of the
   * configuration, not an absence of one, so it is refused.
   * `--authz-unresolved-user allow` restores the old behaviour for a
   * deployment that turns out to rely on it — a security fix should not
   * rewrite every configuration by itself.
   *
   * Both answers are cached for `cacheTTL`, negatives included: a mismatch
   * would otherwise turn every request into a directory search, so a
   * configuration mistake would also become a load problem. The TTL cuts
   * both ways, and neither way is free:
   *
   *  - an identity that appears in the directory after being refused waits
   *    out the TTL before it is looked up again;
   *  - a *positive* answer can go stale. `authzLinid1` resolves an identity
   *    to a DN, so an administrator whose own entry is renamed or moved is
   *    still resolved to the former DN, where no organization names them:
   *    every operation is refused until the TTL runs out. A rename or a
   *    delete therefore drops what was resolved, which closes the window
   *    for the case that produces it; a change made directly in the
   *    directory still waits.
   *
   * `authzScope` resolves the identity itself (`authzScope.ts`), outside
   * this cache, so during such a window it can describe a scope the hooks
   * no longer grant.
   *
   * @param req the request being authorized, which carries an identity
   * @returns the resolved user, or null when the policy is to allow it
   * @throws ForbiddenError when the policy is to deny it
   */
  /** Said once: a rule keyed on a value the authenticator did not publish. */
  private fallbackWarned = false;

  protected async resolveCaller(req: DmRequest): Promise<string | null> {
    const { value, fellBack } = identityFor(req, this.config);
    if (fellBack && !this.fallbackWarned) {
      this.fallbackWarned = true;
      this.logger.warn(
        `${this.name}: --authz-identity asks for req.userName and the ` +
          'authenticator published none, so permissions are read for ' +
          'req.user instead. Rules written on logins will not match'
      );
    }
    const identity = value as string;
    const now = Date.now();
    const cached = this.resolutionCache.get(identity);
    let user: string | null;
    if (cached && now - cached.at < this.cacheTTL) {
      user = cached.user;
    } else {
      user = await this.resolveUser(identity);
      if (this.resolutionCache.size >= AuthzBase.RESOLUTION_CACHE_MAX)
        for (const [key, entry] of this.resolutionCache)
          if (now - entry.at >= this.cacheTTL) this.resolutionCache.delete(key);
      // Under the bound after the prune, or not at all: storing anyway would
      // make the constant a threshold rather than a cap, and the case that
      // reaches it — an identity provider where every user is a new key — is
      // exactly the one this fix is about.
      if (this.resolutionCache.size < AuthzBase.RESOLUTION_CACHE_MAX)
        this.resolutionCache.set(identity, { user, at: now });
      else if (!this.resolutionCacheFullWarned) {
        this.resolutionCacheFullWarned = true;
        this.logger.warn(
          `${this.name}: more than ${AuthzBase.RESOLUTION_CACHE_MAX} ` +
            'identities resolved within one cache window, so resolutions ' +
            'are no longer cached and each request costs a lookup'
        );
      }
    }
    if (user) return user;
    if (this.config.authz_unresolved_user === 'allow') {
      this.logger.warn(
        `User ${identity} could not be resolved by ${this.name}; ` +
          'allowed by --authz-unresolved-user allow'
      );
      return null;
    }
    // The marker is what the error middleware turns into a 403 whose body
    // says nothing about the model — see `setupErrorMiddleware`.
    throw new ForbiddenError(
      `[authz-forbidden] User ${identity} could not be resolved by ` +
        `${this.name}, so no permission can be read for them`
    );
  }

  /** Forget what was resolved, for a test that changes the directory. */
  protected clearResolutionCache(): void {
    this.resolutionCache.clear();
  }

  /**
   * Common hooks for all authorization plugins
   */
  hooks = {
    /**
     * A rename moves the entry an identity resolves to, so what was
     * resolved is dropped.
     *
     * `authzLinid1` keys its permissions on the administrator's DN: renamed
     * or moved, they resolve to a DN no organization names any more, and
     * every operation of theirs is refused until the TTL runs out. The
     * whole map goes rather than one key, since what is cached is
     * identity → DN and the hook carries DNs: a handful of lookups is
     * cheaper than working out which identity moved.
     */
    ldaprenamedone: (): void => {
      this.resolutionCache.clear();
    },

    ldapmodifyrequest: async ([dn, changes, opNumber, req]: [
      string,
      ModifyRequest,
      number,
      DmRequest?,
    ]): Promise<[string, ModifyRequest, number, DmRequest?]> => {
      if (this.shouldSkipAuthorization(req)) {
        return [dn, changes, opNumber, req];
      }

      const user = await this.resolveCaller(req!);
      if (!user) {
        return [dn, changes, opNumber, req];
      }

      // Check if this is a move operation (changing organization link)
      const linkAttr = this.config.ldap_organization_link_attribute;
      if (linkAttr && changes.replace?.[linkAttr]) {
        // For move operations, we need to check:
        // 1. Read permission on the source (current location)
        // 2. Write permission on the destination (new location)

        // First, check read permission on source: the organization the
        // entry is linked to, or its parent branch when that cannot be read.
        //
        // Only the search is inside the `try`. The refusal used to be too, so
        // its own `catch` — meant for a search that failed — swallowed it and
        // judged the parent branch instead: a caller who could read the
        // entry's parent but not the organization it was linked to could
        // move it out, and nothing was logged.
        let sourceBranch = this.extractBranchDn(dn);
        try {
          const currentEntry = (await this.server.ldap.search(
            { paged: false, scope: 'base', attributes: [linkAttr] },
            dn
          )) as SearchResult;
          const currentLink = currentEntry.searchEntries[0]?.[linkAttr];
          const linked = Array.isArray(currentLink)
            ? currentLink[0]
            : currentLink;
          if (linked !== undefined && linked !== null && String(linked) !== '')
            sourceBranch = String(linked);
        } catch {
          // The entry could not be read: its parent branch stands in.
        }
        const sourcePermissions = await this.getUserPermissions(
          user,
          sourceBranch
        );
        if (!sourcePermissions.read) {
          throw new Error(
            `[authz-forbidden] User ${req!.user} does not have read permission for source branch ${sourceBranch}`
          );
        }

        // Then check write permission on destination
        const newLink = changes.replace[linkAttr];
        const destBranch = Array.isArray(newLink)
          ? String(newLink[0])
          : String(newLink);

        const destPermissions = await this.getUserPermissions(user, destBranch);
        if (!destPermissions.write) {
          throw new Error(
            `[authz-forbidden] User ${req!.user} does not have write permission for destination branch ${destBranch}`
          );
        }
      } else {
        // For other modifications, check write permission on the entry's current branch
        const branchToCheck = await this.effectiveBranch(dn);
        const permissions = await this.getUserPermissions(user, branchToCheck);

        if (!permissions.write) {
          throw new Error(
            `[authz-forbidden] User ${req!.user} does not have write permission for branch ${branchToCheck}`
          );
        }
      }

      return [dn, changes, opNumber, req];
    },

    ldapaddrequest: async ([dn, entry, req]: [
      string,
      AttributesList,
      DmRequest?,
    ]): Promise<[string, AttributesList, DmRequest?]> => {
      if (this.shouldSkipAuthorization(req)) {
        return [dn, entry, req];
      }

      const user = await this.resolveCaller(req!);
      if (!user) {
        return [dn, entry, req];
      }

      // Determine which branch to check permissions for
      let branchToCheck: string;

      // If the entry has an organization link, check permissions for that organization
      const linkAttr = this.config.ldap_organization_link_attribute;
      if (linkAttr && entry[linkAttr]) {
        const linkValue = entry[linkAttr];
        branchToCheck = Array.isArray(linkValue)
          ? String(linkValue[0])
          : String(linkValue);
      } else {
        // For organizations (ou entries) or entries without link, check the parent DN
        branchToCheck = this.extractBranchDn(dn);
      }

      const permissions = await this.getUserPermissions(user, branchToCheck);

      // Check write permission
      if (!permissions.write) {
        throw new Error(
          `[authz-forbidden] User ${req!.user} does not have write permission for branch ${branchToCheck}`
        );
      }

      return [dn, entry, req];
    },

    ldapsearchrequest: async ([base, opts, req]: [
      string,
      SearchOptions,
      DmRequest?,
    ]): Promise<[string, SearchOptions, DmRequest?]> => {
      if (this.shouldSkipAuthorization(req)) {
        return [base, opts, req];
      }

      const user = await this.resolveCaller(req!);
      if (!user) {
        return [base, opts, req];
      }

      // Allow base scope search on top organization (for getOrganisationTop)
      if (base === this.config.ldap_top_organization && opts.scope === 'base') {
        return [base, opts, req];
      }

      // Opted in, an administrator reads the directory whole — the
      // organization tree, the groups, the nomenclatures — and what is held
      // to a branch is the accounts, recognised one entry at a time by
      // `ldapsearchfilter` below. Refusing the search here would take the
      // tree and the reference data with it.
      //
      // Off, which is the default, the branch decides as before. Where a
      // branch is a tenant rather than a department, letting a listing cross
      // it is letting a customer read another.
      if (this.config.authz_filter_attached_entries) {
        const branches = await this.getAuthorizedBranches(user);
        if (branches.length === 0) {
          throw new Error(
            `[authz-forbidden] User ${req!.user} administers no branch`
          );
        }
        // Granting the broad read also means supplying the means to enforce
        // it. A caller asking only for the fields it displays — the normal
        // client shape, and what SCIM does — would otherwise get entries
        // carrying no organization link, which `ldapsearchfilter` cannot tell
        // from entries attached to nothing: the filter would pass everything.
        // The attribute is added here and removed again there for callers
        // that did not ask for it.
        const linkAttr = this.config.ldap_organization_link_attribute;
        if (linkAttr && !AuthzBase.wantsAttribute(opts, linkAttr)) {
          const asked = opts.attributes;
          const list = Array.isArray(asked)
            ? asked.map(String)
            : [String(asked)];
          opts = { ...opts, attributes: [...list, linkAttr] };
          AuthzBase.widenedForLink.add(opts);
        }
        return [base, opts, req];
      }

      const permissions = await this.getUserPermissions(user, base);
      if (!permissions.read) {
        throw new Error(
          `[authz-forbidden] User ${req!.user} does not have read permission for branch ${base}`
        );
      }

      return [base, opts, req];
    },

    /**
     * Drop the accounts attached outside the branches this caller manages.
     *
     * Runs after the cache and carries the request, so what one caller may
     * not see never reaches another. An entry with no organization link —
     * an organization, a group, a nomenclature value — is left alone: those
     * are the reference data every administrator reads.
     */
    ldapsearchfilter: async ([result, req, opts]: [
      SearchResult,
      DmRequest?,
      SearchOptions?,
    ]): Promise<[SearchResult, DmRequest?, SearchOptions?]> => {
      const pass: [SearchResult, DmRequest?, SearchOptions?] = [
        result,
        req,
        opts,
      ];
      if (!this.config.authz_filter_attached_entries) return pass;
      const linkAttr = this.config.ldap_organization_link_attribute;
      if (!linkAttr || this.shouldSkipAuthorization(req)) return pass;
      if (!result?.searchEntries?.length) return pass;

      const user = await this.resolveCaller(req!);
      if (!user) return pass;
      const branches = await this.getAuthorizedBranches(user);
      if (branches.length === 0) return pass;

      // RDN by RDN, as everywhere else a DN is compared to a branch
      // (`isDnInBranch`): a text suffix ignores the spaces a hand-written
      // grant may carry after its commas, and reads an escaped separator as
      // one that was not escaped. Either way the verdict is wrong — the
      // account of the administrator holding the branch would be hidden.
      const within = (dn: string): boolean =>
        branches.some(branch => isDnInBranch(dn, branch));

      result.searchEntries = result.searchEntries.filter(entry => {
        const link = entry[linkAttr];
        if (link === undefined || link === null) return true;
        const values = (Array.isArray(link) ? link : [link]).map(String);
        if (values.length === 0) return true;
        if (values.some(within)) return true;
        // Attached outside every branch this caller holds. A link that
        // matches nothing configured lands here too: hidden rather than
        // shown, since a wrong link would otherwise be a way to be seen by
        // everyone — but said out loud, so support can find the entry.
        this.logger.debug(
          `${this.name}: hiding ${String(entry.dn)} from ${req!.user}, attached to ${values[0]}`
        );
        return false;
      });

      // The link was added to the projection so the judgement above could be
      // made; a caller that did not ask for it must not receive it.
      if (opts && AuthzBase.widenedForLink.has(opts)) {
        for (const entry of result.searchEntries) delete entry[linkAttr];
      }

      return [result, req, opts];
    },

    getOrganisationTop: async ([req, defaultTop]: [
      DmRequest | undefined,
      AttributesList | null,
    ]): Promise<[DmRequest | undefined, AttributesList | null]> => {
      // If no user, return default
      if (this.shouldSkipAuthorization(req as DmRequest)) {
        return [req, defaultTop];
      }

      const user = await this.resolveCaller(req as DmRequest);
      if (!user) {
        return [req, defaultTop];
      }

      // Get authorized branches for this user
      const authorizedBranches = await this.getAuthorizedBranches(user);

      // If user has specific authorized branches, return them as top organizations
      if (authorizedBranches.length > 0) {
        const orgs: AttributesList[] = [];
        for (const branch of authorizedBranches) {
          try {
            const result = await this.server.ldap.search(
              { paged: false, scope: 'base' },
              branch,
              req
            );
            if ((result as SearchResult).searchEntries.length === 1) {
              orgs.push((result as SearchResult).searchEntries[0]);
            }
          } catch (err) {
            this.logger.warn(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Failed to fetch authorized branch ${branch}: ${err}`
            );
          }
        }

        if (orgs.length === 1) {
          return [req, orgs[0]];
        } else if (orgs.length > 1) {
          // Return the first one - subclass can override this behavior
          return [req, orgs[0]];
        }
      }

      // Return default if no authorized branches
      return [req, defaultTop];
    },

    ldaprenamerequest: async ([oldDn, newDn, req]: [
      string,
      string,
      DmRequest?,
    ]): Promise<[string, string, DmRequest?]> => {
      if (this.shouldSkipAuthorization(req)) {
        return [oldDn, newDn, req];
      }

      const user = await this.resolveCaller(req!);
      if (!user) {
        return [oldDn, newDn, req];
      }

      // For rename/move operations, we need to check:
      // 1. Read permission on the source (current location)
      // 2. Write permission on the destination (new location)

      // Extract source and destination branches
      const sourceBranch = this.extractBranchDn(oldDn);
      const destBranch = this.extractBranchDn(newDn);

      // Check read permission on source
      const sourcePermissions = await this.getUserPermissions(
        user,
        sourceBranch
      );
      if (!sourcePermissions.read) {
        throw new Error(
          `[authz-forbidden] User ${req!.user} does not have read permission for source branch ${sourceBranch}`
        );
      }

      // Check write permission on destination
      const destPermissions = await this.getUserPermissions(user, destBranch);
      if (!destPermissions.write) {
        throw new Error(
          `[authz-forbidden] User ${req!.user} does not have write permission for destination branch ${destBranch}`
        );
      }

      return [oldDn, newDn, req];
    },

    ldapdeleterequest: async ([dn, req]: [
      string | string[],
      DmRequest?,
    ]): Promise<[string | string[], DmRequest?]> => {
      if (this.shouldSkipAuthorization(req)) {
        return [dn, req];
      }

      const user = await this.resolveCaller(req!);
      if (!user) {
        return [dn, req];
      }

      // Check delete permission on the branch of every target entry.
      const targets = Array.isArray(dn) ? dn : [dn];
      for (const target of targets) {
        const branchToCheck = await this.effectiveBranch(target);
        const permissions = await this.getUserPermissions(user, branchToCheck);
        if (!permissions.delete) {
          throw new Error(
            `[authz-forbidden] User ${req!.user} does not have delete permission for branch ${branchToCheck}`
          );
        }
      }

      return [dn, req];
    },
  };
}
