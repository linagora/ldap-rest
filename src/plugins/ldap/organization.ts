import type { SearchResult } from 'ldapts';
import type { Express, Request, Response } from 'express';

import DmPlugin from '../../abstract/plugin';
import { DM } from '../../bin';
import { Hooks } from '../../hooks';
import { AttributesList, ModifyRequest } from '../../lib/ldapActions';
import {
  tryMethodData,
  tryMethod,
  jsonBody,
  wantJson,
  badRequest,
} from '../../lib/expressFormatedResponses';

export default class LdapOrganizations extends DmPlugin {
  name = 'ldapOrganizations';
  pathAttr: string;
  linkAttr: string;

  constructor(dm: DM) {
    super(dm);
    if (!this.config.ldap_top_organization) {
      throw new Error('Missing --ldap-top-organization');
    }

    this.pathAttr = this.config.ldap_organization_path_attribute as string;
    this.linkAttr = this.config.ldap_organization_link_attribute as string;
  }

  /**
   * API routes for LDAP organizations
   * @param app Express application
   */
  api(app: Express): void {
    // Simple method to get top organization
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/top`,
      async (req, res) => {
        await tryMethodData(res, this.getOrganisationTop.bind(this));
      }
    );

    // Get organization by DN
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn`,
      async (req, res) => {
        const dn = decodeURIComponent(req.params.dn);
        await tryMethodData(res, this.getOrganisationByDn.bind(this), dn);
      }
    );

    // Get subnodes of an organization
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn/subnodes`,
      async (req, res) => {
        const dn = decodeURIComponent(req.params.dn);
        await tryMethodData(res, this.getOrganisationSubnodes.bind(this), dn);
      }
    );

    // Add organization
    app.post(
      `${this.config.api_prefix}/v1/ldap/organizations`,
      async (req, res) => this.apiAdd(req, res)
    );

    // Modify organization
    app.put(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn`,
      async (req, res) => this.apiModify(req, res)
    );

    // Delete organization
    app.delete(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn`,
      async (req, res) => this.apiDelete(req, res)
    );
  }

  async apiAdd(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res, 'ou') as
      | { ou: string; parentDn?: string; [key: string]: any }
      | false;
    if (!body) return;

    const parentDn = body.parentDn || this.config.ldap_top_organization;
    const dn = `ou=${body.ou},${parentDn}`;
    const entry: AttributesList = {
      objectClass: this.config.ldap_organization_class as string[],
      ou: body.ou,
      ...Object.fromEntries(
        Object.entries(body).filter(
          ([key]) => key !== 'ou' && key !== 'parentDn'
        )
      ),
    };

    await tryMethod(res, this.addOrganization.bind(this), dn, entry);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as ModifyRequest | false;
    if (!body) return;
    const dn = decodeURIComponent(req.params.dn);
    if (!dn) return badRequest(res, 'dn is required');
    await tryMethod(res, this.modifyOrganization.bind(this), dn, body);
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const dn = decodeURIComponent(req.params.dn);
    if (!dn) return badRequest(res, 'dn is required');
    await tryMethod(res, this.deleteOrganization.bind(this), dn);
  }

  /**
   * Consistency checks on any entry
   */
  hooks: Hooks = {
    /**
     * If ldap_organization_link_attribute and/or ldap_organization_path_attribute
     * are modified, check that:
     * - the link attribute points to an existing organization dn
     * - the path attribute is valid (starts with ldap_top_organization and
     *   each part is separated by ldap_organization_path_separator)
     *
     * If an ou is going to be deleted, check that it is empty
     */
    ldapaddrequest: async ([dn, entry]) => {
      // Organizations use LDAP hierarchy (DN), not twakeDepartmentLink
      // Only users/groups have twakeDepartmentLink
      if (!this.isOu(entry)) {
        await this.checkDeptLink(entry);
      }
      // Only check path for organizations, not for users/groups
      if (this.isOu(entry)) await this.checkDeptPath(entry);
      return [dn, entry];
    },

    ldapmodifyrequest: async ([dn, changes, op]) => {
      let fakeEntryL: AttributesList = {};
      let fakeEntryP: AttributesList = {};
      let isOrgEntry: boolean | undefined;

      // Determine if this is an organization entry
      const checkIsOu = async () => {
        if (isOrgEntry !== undefined) return isOrgEntry;
        if (changes.replace?.objectClass) {
          isOrgEntry = this.isOu({ objectClass: changes.replace.objectClass });
        } else if (changes.add?.objectClass) {
          isOrgEntry = this.isOu({ objectClass: changes.add.objectClass });
        } else {
          const entry = await this.server.ldap.search(
            { paged: false, scope: 'base' },
            dn
          );
          isOrgEntry =
            (entry as SearchResult).searchEntries.length > 0 &&
            this.isOu((entry as SearchResult).searchEntries[0]);
        }
        return isOrgEntry;
      };

      /**
       * Deletion of path/link attribute is forbidden
       * - Organizations cannot delete path (they use LDAP hierarchy, not link)
       * - Users/groups cannot delete link or path
       */
      if (changes.delete) {
        const hasLinkDelete = Array.isArray(changes.delete)
          ? changes.delete.includes(this.linkAttr)
          : changes.delete[this.linkAttr];
        const hasPathDelete = Array.isArray(changes.delete)
          ? changes.delete.includes(this.pathAttr)
          : changes.delete[this.pathAttr];

        if (hasLinkDelete || hasPathDelete) {
          const isOu = await checkIsOu();
          if (!isOu && hasLinkDelete) {
            throw new Error(`An organization link cannot be deleted`);
          }
          if (hasPathDelete) {
            throw new Error(`An organization path cannot be deleted`);
          }
        }
      }

      /**
       * If link/path attribute is modified, check its validity
       * - Organizations: only validate path
       * - Users/groups: validate both link and path
       */
      if (changes.replace) {
        if (changes.replace[this.linkAttr]) fakeEntryL = { ...changes.replace };
        if (changes.replace[this.pathAttr]) fakeEntryP = { ...changes.replace };
      }
      if (changes.add) {
        if (changes.add[this.linkAttr])
          fakeEntryL = { ...fakeEntryL, ...changes.add };
        if (changes.add[this.pathAttr])
          fakeEntryP = { ...fakeEntryP, ...changes.add };
      }

      // Organizations use LDAP hierarchy, not twakeDepartmentLink
      if (Object.keys(fakeEntryL).length > 0) {
        const isOu = await checkIsOu();
        if (!isOu) {
          await this.checkDeptLink(fakeEntryL);
        }
      }

      if (Object.keys(fakeEntryP).length > 0) {
        const isOu = await checkIsOu();
        if (isOu) {
          await this.checkDeptPath(fakeEntryP);
        }
      }
      return [dn, changes, op];
    },

    ldapdeleterequest: async ([dn]) => {
      // Deletion of a non empty organization is forbidden
      if (/^ou=/.test(dn)) await this.isEmptyOrganization(dn);
      return [dn];
    },

    ldaprenamerequest: ([dn, newdn]) => {
      return [dn, newdn];
    },
  };

  /**
   * Check if the department link is valid
   * @param entry LDAP entry to check
   */
  async checkDeptLink(entry: AttributesList): Promise<void> {
    if (entry[this.linkAttr]) {
      const orgDn = entry[this.linkAttr][0] as string;
      const res = await this.server.ldap.search(
        { paged: false, scope: 'base' },
        orgDn
      );
      if ((res as SearchResult).searchEntries.length === 0)
        throw new Error(`Organization ${orgDn} does not exist`);
      if (
        !new RegExp(`(.*,)?${this.config.ldap_top_organization}`).test(
          (res as SearchResult).searchEntries[0].dn
        )
      )
        throw new Error(`Entry ${orgDn} isn't in top organization branch`);
    }
  }

  /**
   * Check if the department path is valid
   * @param entry LDAP entry to check
   */
  async checkDeptPath(entry: AttributesList): Promise<void> {
    if (entry[this.pathAttr]) {
      const path = entry[this.pathAttr][0] as string;
      const sep = this.config.ldap_organization_path_separator || ' / ';

      let matchingPath = path;
      if (this.isOu(entry)) {
        if (!path.startsWith((entry.ou[0] as string) + sep))
          throw new Error(
            `Organization path must start with its own name followed by separator "${sep}"`
          );
        matchingPath = path.slice((entry.ou[0] as string).length + sep.length);
      }
      const [ou, ouPath] = matchingPath.split(sep, 2);
      if (!ouPath) throw new Error(`Invalid organization path ${path}`);
      const entries = await this.server.ldap.search(
        { paged: false, filter: `(ou=${ou})` },
        this.config.ldap_top_organization
      );
      if ((entries as SearchResult).searchEntries.length === 0)
        throw new Error(`Invalid organization path ${path}`);
      let found = false;
      for (const entry of (entries as SearchResult).searchEntries) {
        const entryPath = entry[this.pathAttr] as string;
        if (entryPath && entryPath === ouPath) {
          found = true;
          break;
        }
      }
      if (!found)
        throw new Error(
          `Invalid organization path ${path}: no matching entry for ${ou} with path ${ouPath}`
        );
    }
  }

  async isEmptyOrganization(dn: string): Promise<void> {
    const res = await this.server.ldap.search({
      paged: false,
      filter: `(${this.config.ldap_organization_link_attribute}=${dn})`,
    });
    if ((res as SearchResult).searchEntries.length > 0)
      throw new Error(`Organization ${dn} is not empty`);
  }

  /**
   * Check if entry is an organisation
   * @param entry LDAP entry to check
   * @returns True if entry is an organisation, false otherwise
   */
  isOu(entry: AttributesList): boolean {
    if (!entry.objectClass) return false;
    return (this.config.ldap_organization_class as string[])
      .filter(c => c.toLowerCase() !== 'top')
      .some(c => (entry.objectClass as string[]).includes(c.toLowerCase()));
  }

  async getOrganisationTop(): Promise<AttributesList> {
    if (!this.config.ldap_top_organization)
      throw new Error('No top organization configured');
    const top = await this.server.ldap.search(
      { paged: false, scope: 'base' },
      this.config.ldap_top_organization
    );
    if ((top as SearchResult).searchEntries.length !== 1)
      throw new Error('Top organization not found');
    return (top as SearchResult).searchEntries[0];
  }

  async getOrganisationByDn(dn: string): Promise<AttributesList> {
    const org = await this.server.ldap.search(
      {
        paged: false,
        scope: 'base',
        filter: '(objectClass=organizationalUnit)',
      },
      dn
    );
    if ((org as SearchResult).searchEntries.length !== 1)
      throw new Error(`Organization ${dn} not found`);
    return (org as SearchResult).searchEntries[0];
  }

  async getOrganisationSubnodes(dn: string): Promise<AttributesList[]> {
    const subs = await this.server.ldap.search(
      {
        paged: true,
        filter: `(${this.config.ldap_organization_link_attribute}=${dn})`,
      },
      this.config.ldap_top_organization as string
    );
    const res: AttributesList[] = [];
    for await (const sub of subs as AsyncGenerator<SearchResult>) {
      res.push(...sub.searchEntries);
    }
    return res;
  }

  async addOrganization(dn: string, entry: AttributesList): Promise<boolean> {
    // Hooks will validate the organization link and path
    return await this.server.ldap.add(dn, entry);
  }

  async modifyOrganization(
    dn: string,
    changes: ModifyRequest
  ): Promise<boolean> {
    // Hooks will validate any changes to organization link and path
    return await this.server.ldap.modify(dn, changes);
  }

  async deleteOrganization(dn: string): Promise<boolean> {
    // Hook will check that organization is empty before deletion
    return await this.server.ldap.delete(dn);
  }
}
