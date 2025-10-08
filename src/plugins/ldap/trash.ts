/**
 * @module core/trash
 * LDAP Trash System - Intercepts delete operations and moves entries to a trash branch
 *
 * When a delete operation occurs on a watched LDAP branch:
 * 1. Check if DN is in a watched branch (configured via DM_TRASH_WATCHED_BASES)
 * 2. Remove any existing entry with same RDN in trash (overwrite old trash)
 * 3. Use LDAP modifyDN to atomically move entry to trash branch
 * 4. Add metadata (deletedAt, originalDN) as description attribute
 * 5. Cancel the native delete operation
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { Hooks } from '../../hooks';
import type { SearchResult } from '../../lib/ldapActions';

class TrashPlugin extends DmPlugin {
  name = 'trash';
  roles: Role[] = ['consistency'] as const;

  private watchedBases: string[] = [];
  private trashBase: string = '';
  private addMetadata: boolean = true;
  private autoCreateTrash: boolean = true;
  private trashInitialized: boolean = false;

  constructor(dm: typeof DmPlugin.prototype.server) {
    super(dm);

    // Parse configuration
    const trashBase = this.config.trash_base;
    this.trashBase =
      typeof trashBase === 'string' ? trashBase : 'ou=trash,dc=example,dc=com';

    const watchedBases = this.config.trash_watched_bases;
    if (typeof watchedBases === 'string' && watchedBases) {
      this.watchedBases = watchedBases
        .split(',')
        .map((base: string) => base.trim())
        .filter((base: string) => base.length > 0);
    }

    this.addMetadata = this.config.trash_add_metadata !== 'false';
    this.autoCreateTrash = this.config.trash_auto_create !== 'false';

    this.logger.info(
      `Trash plugin initialized: base=${this.trashBase}, watched=${this.watchedBases.join(',')}, metadata=${this.addMetadata}`
    );
  }

  /**
   * Check if a DN is in a watched branch
   */
  private isWatched(dn: string): boolean {
    // NEVER intercept deletes from trash itself (prevent infinite loop)
    // Use proper DN suffix matching to avoid false positives
    // (e.g., "uid=trash-user,ou=people" should not match "ou=trash")
    if (dn === this.trashBase || dn.endsWith(',' + this.trashBase)) {
      return false;
    }

    if (this.watchedBases.length === 0) {
      // If no watched bases configured, watch everything except trash
      return true;
    }

    // Use proper DN suffix matching to avoid false positives
    // (e.g., "ou=users" should not match "uid=users-admin,ou=people")
    return this.watchedBases.some(
      base => dn === base || dn.endsWith(',' + base)
    );
  }

  /**
   * Extract RDN from DN (e.g., "uid=john" from "uid=john,ou=users,dc=example,dc=com")
   */
  private extractRDN(dn: string): string {
    const parts = dn.split(',');
    return parts[0];
  }

  /**
   * Build trash DN from original DN
   * uid=john,ou=users,dc=example,dc=com -> uid=john,ou=trash,dc=example,dc=com
   */
  private buildTrashDN(dn: string): string {
    const rdn = this.extractRDN(dn);
    return `${rdn},${this.trashBase}`;
  }

  /**
   * Ensure trash branch exists in LDAP
   */
  private async ensureTrashExists(): Promise<void> {
    if (this.trashInitialized) return;

    if (!this.autoCreateTrash) {
      this.trashInitialized = true;
      return;
    }

    try {
      const result = (await this.server.ldap.search(
        { paged: false },
        this.trashBase
      )) as SearchResult;

      if (result.searchEntries.length > 0) {
        this.logger.debug(`Trash branch ${this.trashBase} already exists`);
        this.trashInitialized = true;
        return;
      }
    } catch {
      // Branch doesn't exist, try to create it
      this.logger.info(`Creating trash branch ${this.trashBase}`);
    }

    try {
      const rdn = this.extractRDN(this.trashBase);
      const ouName = rdn.split('=')[1];

      await this.server.ldap.add(this.trashBase, {
        objectClass: ['top', 'organizationalUnit'],
        ou: ouName,
        description: 'LDAP Trash - Deleted entries are moved here',
      });

      this.logger.info(`Trash branch ${this.trashBase} created successfully`);
      this.trashInitialized = true;
    } catch (error) {
      this.logger.error(
        `Failed to create trash branch ${this.trashBase}: ${String(error)}`
      );
      throw new Error(
        `Trash plugin: Unable to create trash branch ${this.trashBase}. Please create it manually or set DM_TRASH_AUTO_CREATE=false`
      );
    }
  }

  /**
   * Remove old entry from trash if it exists (to allow overwrite)
   */
  private async removeOldTrashEntry(trashDn: string): Promise<void> {
    try {
      const result = (await this.server.ldap.search(
        { paged: false },
        trashDn
      )) as SearchResult;

      if (result.searchEntries.length > 0) {
        this.logger.info(
          `Removing old trash entry ${trashDn} before overwrite`
        );
        await this.server.ldap.delete(trashDn);
        this.logger.debug(`Old trash entry ${trashDn} deleted`);
      }
    } catch (error) {
      // Entry doesn't exist, that's fine
      this.logger.debug(
        `No old trash entry to remove at ${trashDn}: ${String(error)}`
      );
    }
  }

  /**
   * Add metadata to trash entry (deletedAt, originalDN)
   */
  private async addMetadataToTrash(
    trashDn: string,
    originalDn: string
  ): Promise<void> {
    if (!this.addMetadata) return;

    try {
      const timestamp = new Date().toISOString();
      const metadata = `Deleted on ${timestamp} from ${originalDn}`;

      await this.server.ldap.modify(trashDn, {
        replace: {
          description: metadata,
        },
      });

      this.logger.debug(`Metadata added to ${trashDn}`);
    } catch (error) {
      this.logger.warn(
        `Failed to add metadata to ${trashDn}: ${String(error)}. Entry moved to trash but without metadata.`
      );
      // Don't throw - metadata is optional
    }
  }

  hooks: Hooks = {
    /**
     * Intercept LDAP delete operations and move to trash instead
     * This is a chained hook that receives a DN or array of DNs
     * and can modify or filter them before deletion
     */
    ldapdeleterequest: async (dn: string | string[]) => {
      // Convert to array for easier processing
      const dnsToProcess = Array.isArray(dn) ? dn : [dn];
      const dnsToDelete: string[] = [];

      for (const currentDn of dnsToProcess) {
        // Check if this DN is in a watched branch
        if (!this.isWatched(currentDn)) {
          this.logger.debug(
            `Trash plugin: ${currentDn} not in watched branches, allowing native delete`
          );
          dnsToDelete.push(currentDn); // Allow native delete
          continue;
        }

        this.logger.info(`Trash plugin: Intercepting delete of ${currentDn}`);

        // Ensure trash branch exists
        await this.ensureTrashExists();

        // Build trash DN
        const trashDn = this.buildTrashDN(currentDn);

        // Remove old trash entry if exists (overwrite)
        await this.removeOldTrashEntry(trashDn);

        try {
          // Use LDAP move to atomically move entry to trash
          this.logger.debug(
            `Moving ${currentDn} to ${trashDn} using LDAP move (atomic)`
          );

          await this.server.ldap.move(currentDn, trashDn);

          this.logger.info(`Entry ${currentDn} moved to trash at ${trashDn}`);

          // Add metadata (non-blocking)
          await this.addMetadataToTrash(trashDn, currentDn);

          // Don't add to dnsToDelete - this DN is already moved to trash
        } catch (error) {
          this.logger.error(
            `Trash plugin: Failed to move ${currentDn} to trash: ${String(error)}`
          );

          // Check if it's a permission error
          if (
            error instanceof Error &&
            (error.message.includes('Insufficient access') ||
              error.message.includes('permissions') ||
              error.message.includes('access denied'))
          ) {
            throw new Error(
              `Trash plugin: Insufficient LDAP permissions to move ${currentDn} to trash. ` +
                `Please grant modifyDN permissions or disable trash plugin. Original error: ${error.message}`
            );
          }

          // Re-throw other errors
          throw new Error(
            `Trash plugin: Failed to move ${currentDn} to trash: ${String(error)}`
          );
        }
      }

      // Return the list of DNs that should still be deleted normally
      // If input was an array, return array; if single string, return string or undefined
      // Returning undefined indicates no deletion should occur (all handled by trash)
      return Array.isArray(dn) ? dnsToDelete : (dnsToDelete[0] ?? undefined);
    },
  };
}

export default TrashPlugin;
