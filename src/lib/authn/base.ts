/**
 * @module lib/authn/base
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Base class for authorization plugins
 * Provides common functionality for permission-based access control
 * @group Libraries
 */
import DmPlugin, { type Role } from '../../abstract/plugin';
import type { BranchPermissions } from '../../config/args';

/**
 * Abstract base class for authorization plugins
 * Provides common utility methods and interface for LDAP-based authorization
 */
export default abstract class AuthnBase extends DmPlugin {
  roles: Role[] = ['authn'] as const;
  cacheTTL!: number;

  /**
   * Extract the branch DN to check permissions against
   * For a DN like "uid=user,ou=users,ou=org,dc=example,dc=com"
   * we need to check permissions on the parent branch
   */
  extractBranchDn(dn: string): string {
    // Remove the first RDN component to get the parent branch
    const parts = dn.split(',');
    if (parts.length <= 1) {
      return dn;
    }
    return parts.slice(1).join(',');
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
