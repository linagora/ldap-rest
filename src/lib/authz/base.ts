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
import type { BranchPermissions } from '../../config/args';
import type { DmRequest } from '../auth/base';
import type {
  AttributesList,
  ModifyRequest,
  SearchResult,
  AttributeValue,
} from '../ldapActions';
import { getParentDn } from '../utils';

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
   * Check if authorization should be skipped for this request
   * Can be overridden by subclasses for custom logic
   */
  protected shouldSkipAuthorization(req?: DmRequest): boolean {
    return !req?.user;
  }

  /**
   * Common hooks for all authorization plugins
   */
  hooks = {
    ldapmodifyrequest: async ([dn, changes, opNumber, req]: [
      string,
      ModifyRequest,
      number,
      DmRequest?,
    ]): Promise<[string, ModifyRequest, number, DmRequest?]> => {
      if (this.shouldSkipAuthorization(req)) {
        return [dn, changes, opNumber, req];
      }

      const user = await this.resolveUser(req!.user!);
      if (!user) {
        this.logger.warn(`User ${req!.user} could not be resolved`);
        return [dn, changes, opNumber, req];
      }

      // Check if this is a move operation (changing organization link)
      const linkAttr = this.config.ldap_organization_link_attribute;
      if (linkAttr && changes.replace?.[linkAttr]) {
        // For move operations, we need to check:
        // 1. Read permission on the source (current location)
        // 2. Write permission on the destination (new location)

        // First, check read permission on source
        // Get the current entry to find its current organization link
        try {
          const currentEntry = (await this.server.ldap.search(
            { paged: false, scope: 'base', attributes: [linkAttr] },
            dn
          )) as SearchResult;

          if (currentEntry.searchEntries.length > 0) {
            const currentLink = currentEntry.searchEntries[0][linkAttr];
            const sourceBranch = Array.isArray(currentLink)
              ? String(currentLink[0])
              : String(currentLink);

            const sourcePermissions = await this.getUserPermissions(
              user,
              sourceBranch
            );
            if (!sourcePermissions.read) {
              throw new Error(
                `[authz-forbidden] User ${req!.user} does not have read permission for source branch ${sourceBranch}`
              );
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (err) {
          // If we can't read the current entry, check permissions on the entry's parent branch
          const sourceBranch = this.extractBranchDn(dn);
          const sourcePermissions = await this.getUserPermissions(
            user,
            sourceBranch
          );
          if (!sourcePermissions.read) {
            throw new Error(
              `[authz-forbidden] User ${req!.user} does not have read permission for source branch ${sourceBranch}`
            );
          }
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

      const user = await this.resolveUser(req!.user!);
      if (!user) {
        this.logger.warn(`User ${req!.user} could not be resolved`);
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

      const user = await this.resolveUser(req!.user!);
      if (!user) {
        this.logger.warn(`User ${req!.user} could not be resolved`);
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

      const user = await this.resolveUser(req!.user!);
      if (!user) return pass;
      const branches = await this.getAuthorizedBranches(user);
      if (branches.length === 0) return pass;

      const within = (dn: string): boolean => {
        const target = dn.toLowerCase();
        return branches.some(b => {
          const branch = b.toLowerCase();
          return target === branch || target.endsWith(`,${branch}`);
        });
      };

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

      const user = await this.resolveUser((req as DmRequest).user!);
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

      const user = await this.resolveUser(req!.user!);
      if (!user) {
        this.logger.warn(`User ${req!.user} could not be resolved`);
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

      const user = await this.resolveUser(req!.user!);
      if (!user) {
        this.logger.warn(`User ${req!.user} could not be resolved`);
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
