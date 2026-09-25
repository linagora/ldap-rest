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
import { roleAttribute, type Schema } from '../../config/schema';
import {
  getParentDn,
  escapeLdapFilter,
  isDnInBranch,
  normalizeDn,
  parseDn,
  rdnValue,
} from '../../lib/utils';

/** The attributes an entry uses to name its organization and copy its path */
interface LinkedAttributes {
  link: string;
  path: string;
}

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

  /**
   * The attribute holding an organization's path: the `organizationPath` role
   * of the organization schema, then the configured name.
   *
   * Role first, as the enterprise rules read it: a deployment naming the
   * attribute only through the role otherwise saw nothing recomputed, and
   * nothing said so. Resolved on each call, the organization schema being
   * read asynchronously.
   *
   * @returns the attribute name
   */
  private organizationPathAttribute(): string {
    const organizations = this.server.loadedPlugins['ldapOrganizations'] as
      | { schema?: Schema }
      | undefined;
    return (
      roleAttribute(organizations?.schema, 'organizationPath') || this.pathAttr
    );
  }

  /**
   * The link and path attributes of the entries attached to an organization:
   * those every loaded entity schema declares through the `organizationLink`
   * and `organizationPath` roles, then the configured names.
   *
   * @returns distinct pairs, the ones declared by roles first
   */
  private linkedAttributes(): LinkedAttributes[] {
    const schemas: (Schema | undefined)[] = [];
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      | { instances?: { schema?: Schema }[] }
      | undefined;
    for (const instance of flat?.instances || []) schemas.push(instance.schema);
    const groups = this.server.loadedPlugins['ldapGroups'] as
      | { schema?: Schema }
      | undefined;
    schemas.push(groups?.schema);

    const pairs: LinkedAttributes[] = [];
    for (const schema of schemas) {
      const link = roleAttribute(schema, 'organizationLink');
      if (!link) continue;
      pairs.push({
        link,
        path: roleAttribute(schema, 'organizationPath') || this.pathAttr,
      });
    }
    pairs.push({ link: this.linkAttr, path: this.pathAttr });

    const seen = new Set<string>();
    return pairs.filter(({ link, path }) => {
      const key = `${link.toLowerCase()} ${path.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

        // The tree first: the linked entries copy their path from it
        await this.updateOrganizationPaths(newDn);

        for (const attrs of this.linkedAttributes()) {
          // Update resources linked to the renamed organization
          await this.updateLinkedResources(oldDn, newDn, baseDn, attrs);

          // Update resources linked to sub-organizations (descendants)
          // When an org is moved, LDAP automatically moves its children,
          // but their DN changes, so we need to update references
          await this.updateDescendantReferences(oldDn, newDn, baseDn, attrs);
        }
      } catch (err) {
        this.logger.error(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `Error synchronizing department links after rename: ${err}`
        );
      }
    },
  };

  /**
   * Recompute the path of a renamed or moved organization and of every
   * organization below it.
   *
   * A path names an organization's ancestors, root first, its own name last,
   * the top organization left out. Moving or renaming one therefore changes
   * the path of its whole subtree. Only the entries *linked* to the tree used
   * to be updated, from paths the tree itself still held: the organizations
   * kept the path of their former parent, the linked users were rewritten to
   * it, and nothing could correct it since the path is computed by the server.
   *
   * Only organizations already holding a path are written.
   *
   * @param orgDn DN of the organization after the rename
   */
  private async updateOrganizationPaths(orgDn: string): Promise<void> {
    const pathAttr = this.organizationPathAttribute();
    const top = this.config.ldap_top_organization;
    if (!top || !isDnInBranch(orgDn, top)) return;
    const separator =
      (this.config.ldap_organization_path_separator as string) || ' / ';

    const results = await this.server.ldap.search(
      {
        paged: true,
        scope: 'sub',
        filter: `(${pathAttr}=*)`,
        attributes: [pathAttr],
      },
      orgDn
    );
    const organizations: { dn: string; path: string }[] = [];
    for await (const result of results as AsyncGenerator<SearchResult>) {
      for (const entry of result.searchEntries) {
        const dn = String(entry.dn);
        if (!/^ou=/i.test(dn)) continue;
        const value = entry[pathAttr];
        organizations.push({
          dn,
          path: String(Array.isArray(value) ? value[0] : value),
        });
      }
    }
    // Parents before their children, so each one reads a parent already fixed
    organizations.sort((a, b) => parseDn(a.dn).length - parseDn(b.dn).length);

    const topKey = normalizeDn(top);
    const computed = new Map<string, string>();
    let updated = 0;
    for (const { dn, path } of organizations) {
      const parent = getParentDn(dn);
      const parentKey = normalizeDn(parent);
      let parentPath: string | undefined;
      if (parentKey !== topKey) {
        parentPath =
          computed.get(parentKey) ?? (await this.readPath(parent)) ?? undefined;
        if (parentPath === undefined) {
          this.logger.warn(
            `Organization ${parent} has no ${pathAttr}: the path of ${dn} is left as it is`
          );
          continue;
        }
      }
      const name = rdnValue(dn);
      const newPath = parentPath ? `${parentPath}${separator}${name}` : name;
      computed.set(normalizeDn(dn), newPath);
      if (newPath === path) continue;
      try {
        await this.server.ldap.modify(dn, {
          replace: { [pathAttr]: newPath },
        });
        updated++;
      } catch (err) {
        this.logger.error(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `Failed to update the path of ${dn} after organization rename: ${err}`
        );
      }
    }
    this.logger.info(
      `Updated the path of ${updated} organizations below ${orgDn}`
    );
  }

  /**
   * Read the path an organization holds.
   *
   * @param dn organization DN
   * @returns its path, or null when it holds none or cannot be read
   */
  private async readPath(dn: string): Promise<string | null> {
    const pathAttr = this.organizationPathAttribute();
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: [pathAttr] },
        dn
      )) as SearchResult;
      const value = result.searchEntries[0]?.[pathAttr];
      if (value === undefined) return null;
      return String(Array.isArray(value) ? value[0] : value);
    } catch {
      return null;
    }
  }

  /**
   * Update resources that are directly linked to the renamed organization
   */
  private async updateLinkedResources(
    oldDn: string,
    newDn: string,
    baseDn: string,
    attrs: LinkedAttributes
  ): Promise<void> {
    const filter = `(${attrs.link}=${escapeLdapFilter(oldDn)})`;
    this.logger.debug(
      `Searching for resources directly linked to ${oldDn}: ${filter}`
    );

    const results = await this.server.ldap.search(
      {
        paged: true,
        filter,
        attributes: [attrs.link, attrs.path],
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
              [attrs.link]: newDn,
              [attrs.path]: newPath,
            },
          });

          updatedCount++;
          this.logger.debug(
            `Updated ${entryDn}: ${attrs.link}=${newDn}, ${attrs.path}=${newPath}`
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
    baseDn: string,
    attrs: LinkedAttributes
  ): Promise<void> {
    // Find all resources that have the linkAttr attribute
    // We'll filter for descendants in code since LDAP wildcards don't work well here
    const filter = `(${attrs.link}=*)`;
    this.logger.debug(
      `Searching for resources linked to descendants of ${oldParentDn}: ${filter}`
    );

    const results = await this.server.ldap.search(
      {
        paged: true,
        filter,
        attributes: [attrs.link, attrs.path],
      },
      baseDn
    );

    let updatedCount = 0;

    for await (const result of results as AsyncGenerator<SearchResult>) {
      for (const entry of result.searchEntries) {
        const entryDn = String(entry.dn);
        const oldLink = entry[attrs.link];
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
              [attrs.link]: newLink,
              [attrs.path]: newPath,
            },
          });

          updatedCount++;
          this.logger.debug(
            `Updated descendant link ${entryDn}: ${attrs.link}=${newLink}, ${attrs.path}=${newPath}`
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
    const pathAttr = this.organizationPathAttribute();
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: [pathAttr, 'ou', 'o'] },
        orgDn
      )) as SearchResult;

      if (!result.searchEntries || result.searchEntries.length === 0) {
        throw new Error(`Organization ${orgDn} not found`);
      }

      const org = result.searchEntries[0];

      // Return the path attribute if it exists
      if (org[pathAttr]) {
        const path = org[pathAttr];
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
        `Organization ${orgDn} has no ${pathAttr} attribute, using DN`
      );
      return orgDn;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to fetch organization ${orgDn}: ${err}`);
    }
  }
}
