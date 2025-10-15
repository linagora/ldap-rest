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
} from '../ldapActions';
import { getParentDn } from '../utils';

/**
 * Abstract base class for authorization plugins
 * Provides common utility methods and interface for LDAP-based authorization
 */
export default abstract class AuthzBase extends DmPlugin {
  roles: Role[] = ['authz'] as const;
  cacheTTL!: number;

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
                `User ${req!.user} does not have read permission for source branch ${sourceBranch}`
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
              `User ${req!.user} does not have read permission for source branch ${sourceBranch}`
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
            `User ${req!.user} does not have write permission for destination branch ${destBranch}`
          );
        }
      } else {
        // For other modifications, check write permission on the entry's current branch
        const branchToCheck = this.extractBranchDn(dn);
        const permissions = await this.getUserPermissions(user, branchToCheck);

        if (!permissions.write) {
          throw new Error(
            `User ${req!.user} does not have write permission for branch ${branchToCheck}`
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
          `User ${req!.user} does not have write permission for branch ${branchToCheck}`
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

      const permissions = await this.getUserPermissions(user, base);

      // Check read permission
      if (!permissions.read) {
        throw new Error(
          `User ${req!.user} does not have read permission for branch ${base}`
        );
      }

      return [base, opts, req];
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
          `User ${req!.user} does not have read permission for source branch ${sourceBranch}`
        );
      }

      // Check write permission on destination
      const destPermissions = await this.getUserPermissions(user, destBranch);
      if (!destPermissions.write) {
        throw new Error(
          `User ${req!.user} does not have write permission for destination branch ${destBranch}`
        );
      }

      return [oldDn, newDn, req];
    },
  };
}
