/**
 * @module plugins/ldap/departmentSync
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Plugin to maintain consistency of department links when organizations are renamed/moved
 * Automatically updates twakeDepartmentLink and twakeDepartmentPath attributes on all
 * resources (users, groups, etc.) when their linked organization DN changes.
 */

import type { SearchResult } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';

export default class LdapDepartmentSync extends DmPlugin {
  name = 'ldapDepartmentSync';
  roles: Role[] = ['consistency'] as const;

  private linkAttr: string;
  private pathAttr: string;

  constructor(server: DM) {
    super(server);

    this.linkAttr =
      (this.config.ldap_organization_link_attribute as string) ||
      'twakeDepartmentLink';
    this.pathAttr =
      (this.config.ldap_organization_path_attribute as string) ||
      'twakeDepartmentPath';
  }

  hooks: Hooks = {
    /**
     * After an organization is renamed/moved, update all resources
     * (users, groups, etc.) that reference the old DN or its descendants
     * via twakeDepartmentLink
     */
    ldaprenamedone: async ([oldDn, newDn]) => {
      // Only process organization renames (ou=...)
      if (!/^ou=/.test(oldDn)) return;

      this.logger.info(
        `Organization renamed from ${oldDn} to ${newDn}, synchronizing linked resources...`
      );

      try {
        const baseDn = (this.config.ldap_top_organization as string).replace(
          /^ou=[^,]+,/,
          ''
        );

        // Update resources linked to the renamed organization
        await this.updateLinkedResources(oldDn, newDn, baseDn);

        // Update resources linked to sub-organizations (descendants)
        // When an org is moved, LDAP automatically moves its children,
        // but their DN changes, so we need to update references
        await this.updateDescendantReferences(oldDn, newDn, baseDn);
      } catch (err) {
        this.logger.error(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `Error synchronizing department links after rename: ${err}`
        );
      }
    },
  };

  /**
   * Update resources that are directly linked to the renamed organization
   */
  private async updateLinkedResources(
    oldDn: string,
    newDn: string,
    baseDn: string
  ): Promise<void> {
    const filter = `(${this.linkAttr}=${oldDn})`;
    this.logger.debug(
      `Searching for resources directly linked to ${oldDn}: ${filter}`
    );

    const results = await this.server.ldap.search(
      {
        paged: true,
        filter,
        attributes: [this.linkAttr, this.pathAttr],
      },
      baseDn
    );

    let updatedCount = 0;

    for await (const result of results as AsyncGenerator<SearchResult>) {
      for (const entry of result.searchEntries) {
        const entryDn = String(entry.dn);

        try {
          // Get the new department path from the new organization
          const newPath = await this.getDepartmentPath(newDn);

          // Update the entry
          await this.server.ldap.modify(entryDn, {
            replace: {
              [this.linkAttr]: newDn,
              [this.pathAttr]: newPath,
            },
          });

          updatedCount++;
          this.logger.debug(
            `Updated ${entryDn}: ${this.linkAttr}=${newDn}, ${this.pathAttr}=${newPath}`
          );
        } catch (err) {
          this.logger.error(
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            `Failed to update ${entryDn} after organization rename: ${err}`
          );
        }
      }
    }

    this.logger.info(
      `Updated ${updatedCount} resources directly linked to the renamed organization`
    );
  }

  /**
   * Update resources linked to sub-organizations that were moved
   * When ou=IT moves from ou=IT,ou=Departments to ou=IT,ou=Tech,
   * its child ou=Dev,ou=IT,ou=Departments becomes ou=Dev,ou=IT,ou=Tech
   * We need to update resources pointing to the old child DN
   */
  private async updateDescendantReferences(
    oldParentDn: string,
    newParentDn: string,
    baseDn: string
  ): Promise<void> {
    // Find all resources that have the linkAttr attribute
    // We'll filter for descendants in code since LDAP wildcards don't work well here
    const filter = `(${this.linkAttr}=*)`;
    this.logger.debug(
      `Searching for resources linked to descendants of ${oldParentDn}: ${filter}`
    );

    const results = await this.server.ldap.search(
      {
        paged: true,
        filter,
        attributes: [this.linkAttr, this.pathAttr],
      },
      baseDn
    );

    let updatedCount = 0;

    for await (const result of results as AsyncGenerator<SearchResult>) {
      for (const entry of result.searchEntries) {
        const entryDn = String(entry.dn);
        const oldLink = entry[this.linkAttr];
        const oldLinkStr = Array.isArray(oldLink)
          ? String(oldLink[0])
          : String(oldLink);

        // Skip if this is the direct link (already handled above)
        if (oldLinkStr === oldParentDn) continue;

        // Only process if this link is a descendant of the renamed organization
        if (!oldLinkStr.endsWith(`,${oldParentDn}`)) continue;

        try {
          // Replace the old parent DN with the new parent DN in the link
          // Example: "ou=Dev,ou=IT,ou=Departments" -> "ou=Dev,ou=IT,ou=Tech"
          const newLink = oldLinkStr.replace(
            `,${oldParentDn}`,
            `,${newParentDn}`
          );

          // Get the new department path from the new organization
          const newPath = await this.getDepartmentPath(newLink);

          // Update the entry
          await this.server.ldap.modify(entryDn, {
            replace: {
              [this.linkAttr]: newLink,
              [this.pathAttr]: newPath,
            },
          });

          updatedCount++;
          this.logger.debug(
            `Updated descendant link ${entryDn}: ${this.linkAttr}=${newLink}, ${this.pathAttr}=${newPath}`
          );
        } catch (err) {
          this.logger.error(
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            `Failed to update descendant reference ${entryDn}: ${err}`
          );
        }
      }
    }

    this.logger.info(
      `Updated ${updatedCount} resources linked to descendants of the renamed organization`
    );
  }

  /**
   * Get department path from an organization DN
   * Fetches the path attribute directly from the organization entry
   */
  private async getDepartmentPath(orgDn: string): Promise<string> {
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: [this.pathAttr, 'ou', 'o'] },
        orgDn
      )) as SearchResult;

      if (!result.searchEntries || result.searchEntries.length === 0) {
        throw new Error(`Organization ${orgDn} not found`);
      }

      const org = result.searchEntries[0];

      // Return the path attribute if it exists
      if (org[this.pathAttr]) {
        const path = org[this.pathAttr];
        return Array.isArray(path) ? String(path[0]) : String(path);
      }

      // Fallback: construct path from ou or o attribute
      const ou = org.ou || org.o;
      if (ou) {
        const name = Array.isArray(ou) ? String(ou[0]) : String(ou);
        return `/${name}`;
      }

      // Last resort: use the DN
      this.logger.warn(
        `Organization ${orgDn} has no ${this.pathAttr} attribute, using DN`
      );
      return orgDn;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to fetch organization ${orgDn}: ${err}`);
    }
  }
}
