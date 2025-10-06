/**
 * @module lib/authz/base
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Base class for authorization plugins
 * Provides common functionality for permission-based access control
 * @group Libraries
 */
import DmPlugin, { type Role } from '../../abstract/plugin';
import type { BranchPermissions } from '../../config/args';
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
}
