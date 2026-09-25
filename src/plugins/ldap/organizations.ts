import fs from 'fs';

import type { SearchResult } from 'ldapts';
import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { DM } from '../../bin';
import { Hooks } from '../../hooks';
import {
  AttributesList,
  AttributeValue,
  ModifyRequest,
} from '../../lib/ldapActions';
import {
  tryMethodData,
  tryMethod,
  jsonBody,
  wantJson,
} from '../../lib/expressFormatedResponses';
import {
  asyncHandler,
  escapeDnValue,
  escapeLdapFilter,
  getParentDn,
  getRdn,
  isChildOf,
  isDnInBranch,
  launchHooksChained,
  normalizeDn,
  rdnValue,
  transformSchemas,
  validateDnValue,
} from '../../lib/utils';
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
} from '../../lib/errors';
import { extractLdapCode } from '../../lib/ldapCodes';
import type { Schema } from '../../config/schema';
import {
  assertClientMaySet,
  checkDnValues,
  matchesPattern,
  modifiedAttributeNames,
  missingRequiredAttribute,
} from '../../config/schema';

/**
 * Shared OpenAPI schemas surfaced by this plugin. Picked up by
 * scripts/generate-openapi.ts and merged into `components.schemas`.
 *
 * @openapi-component
 * Organization:
 *   type: object
 *   description: An LDAP organizational unit entry.
 *   required: [dn, ou]
 *   properties:
 *     dn:
 *       type: string
 *       description: Fully-qualified distinguished name of the entry.
 *       example: ou=Engineering,ou=organizations,dc=example,dc=com
 *     ou:
 *       type: string
 *       description: Organizational unit name (RDN attribute).
 *       example: Engineering
 *     o:
 *       type: string
 *       description: Organization display name.
 *       example: Engineering Department
 *     l:
 *       type: string
 *       description: Locality / city.
 *       example: Paris
 *     description:
 *       type: string
 *       example: Software engineering division
 *     organizationLink:
 *       type: string
 *       description: DN of the parent organization (link attribute).
 *       example: ou=organizations,dc=example,dc=com
 *     organizationPath:
 *       type: string
 *       description: |
 *         Human-readable slash-separated path to this node, used by the
 *         UI tree. Set automatically on creation and move.
 *       example: Engineering / Backend
 *     member:
 *       type: array
 *       items: { type: string }
 *       description: DNs of entries linked to this organization.
 *       example:
 *         - uid=alice,ou=users,dc=example,dc=com
 * OrgSummary:
 *   type: object
 *   description: Lightweight organization reference (used in node lists).
 *   required: [dn, ou]
 *   properties:
 *     dn: { type: string, example: ou=HR,ou=organizations,dc=example,dc=com }
 *     ou: { type: string, example: HR }
 *     description: { type: string }
 *     objectClass:
 *       type: array
 *       items: { type: string }
 *       example: [top, organizationalUnit]
 * OrganizationCreate:
 *   type: object
 *   required: [ou]
 *   properties:
 *     ou:
 *       type: string
 *       description: Name of the new organizational unit.
 *       example: Marketing
 *     parentDn:
 *       type: string
 *       description: |
 *         DN of the parent organizational unit. Defaults to the configured
 *         top organization when omitted.
 *       example: ou=organizations,dc=example,dc=com
 *     description: { type: string }
 *     l: { type: string }
 *   example:
 *     ou: Marketing
 *     parentDn: ou=organizations,dc=example,dc=com
 *     description: Marketing division
 * OrganizationModify:
 *   type: object
 *   description: |
 *     Partial update. Any provided attribute is replaced wholesale.
 *     `ou` cannot be changed via this endpoint — use the move endpoint
 *     to relocate the node within the tree.
 *   properties:
 *     description: { type: string }
 *     l: { type: string }
 *     o: { type: string }
 *   example:
 *     description: Updated description for Marketing
 */
export default class LdapOrganizations extends DmPlugin {
  name = 'ldapOrganizations';
  roles: Role[] = ['api', 'consistency', 'configurable'] as const;
  pathAttr: string;
  linkAttr: string;
  schema?: Schema;

  constructor(dm: DM) {
    super(dm);
    if (!this.config.ldap_top_organization) {
      throw new Error('Missing --ldap-top-organization');
    }

    this.pathAttr = this.config.ldap_organization_path_attribute as string;
    this.linkAttr = this.config.ldap_organization_link_attribute as string;

    // Load organization schema if provided
    if (this.config.organization_schema) {
      fs.readFile(this.config.organization_schema, (err, data) => {
        if (err) {
          this.logger.error(
            `Failed to load organization schema from ${this.config.organization_schema}: ${err}`
          );
        } else {
          try {
            this.schema = JSON.parse(
              transformSchemas(data.toString(), this.config)
            ) as Schema;
            this.logger.debug('Organization schema loaded');
          } catch (e) {
            this.logger.error(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Failed to parse organization schema: ${e}`
            );
          }
        }
      });
    }
  }

  /**
   * API routes for LDAP organizations
   * @param app Express application
   */
  api(app: Express): void {
    /**
     * @openapi
     * summary: Get top organization
     * description: |
     *   Returns the single root organizational unit configured via
     *   `--ldap-top-organization`. Authorization plugins may filter the result
     *   to only the branches the caller has access to.
     * responses:
     *   '200':
     *     description: Top organization entry.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Organization' }
     *         example:
     *           dn: ou=organizations,dc=example,dc=com
     *           ou: organizations
     *           description: Root organization
     *           objectClass: [top, organizationalUnit]
     *   '404':
     *     description: Top organization not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Simple method to get top organization
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/top`,
      async (req, res) => {
        await tryMethodData(res, async () =>
          this.hideNeverReturn(await this.getOrganisationTop(req))
        );
      }
    );

    /**
     * @openapi
     * summary: Get organization by DN
     * description: |
     *   The `:dn` segment must be the URL-encoded fully-qualified DN of the
     *   organizational unit (e.g. `ou=Engineering%2Cou=organizations%2Cdc%3Dexample%2Cdc%3Dcom`).
     *   Returns a 404 when the DN does not exist or does not have
     *   `objectClass=organizationalUnit`.
     * responses:
     *   '200':
     *     description: Organization entry.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Organization' }
     *         example:
     *           dn: ou=Engineering,ou=organizations,dc=example,dc=com
     *           ou: Engineering
     *           description: Software engineering division
     *           objectClass: [top, organizationalUnit]
     *   '404':
     *     description: Organization not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Get organization by DN
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn`,
      async (req, res) => {
        const dn = decodeURIComponent(req.params.dn);
        await tryMethodData(res, async () =>
          this.hideNeverReturn(await this.getOrganisationByDn(dn, req))
        );
      }
    );

    /**
     * @openapi
     * summary: List subnodes of an organization
     * description: |
     *   Returns the direct child organizational units of `:dn`, followed by
     *   up to `ldap_organization_max_subnodes` (default 50) entries (users,
     *   groups) whose organization-link attribute points to it.
     *
     *   Two things bound the answer, and each appends a sentinel entry with
     *   `objectClass: [moreIndicator]` and `_isMoreIndicator: "true"`, which
     *   a client must drop before treating the rest as entries:
     *
     *   - the cap on the attached entries, whose sentinel is at
     *     `more-<dn>` and carries `_totalCount` and `_displayedCount`;
     *   - a directory refusing to list a branch in one answer, whose
     *     sentinel is at `more-organizations-<dn>` and carries
     *     `_displayedCount` alone — nothing counted the rest.
     *
     *   Child organizations are not capped.
     * parameters:
     *   - in: query
     *     name: objectClass
     *     schema: { type: string }
     *     description: |
     *       Filter linked entities by objectClass (e.g. `inetOrgPerson`,
     *       `groupOfNames`). Pass `organizationalUnit` to return only child OUs.
     *     example: inetOrgPerson
     * responses:
     *   '200':
     *     description: List of subnodes.
     *     content:
     *       application/json:
     *         schema:
     *           type: array
     *           items: { $ref: '#/components/schemas/OrgSummary' }
     *         example:
     *           - dn: ou=Backend,ou=Engineering,ou=organizations,dc=example,dc=com
     *             ou: Backend
     *             objectClass: [top, organizationalUnit]
     *           - dn: uid=alice,ou=users,dc=example,dc=com
     *             uid: alice
     *             cn: Alice Smith
     *             objectClass: [top, inetOrgPerson]
     *   '404':
     *     description: Organization not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Get subnodes of an organization
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn/subnodes`,
      async (req, res) => {
        const dn = decodeURIComponent(req.params.dn);
        await tryMethodData(res, async () =>
          this.hideNeverReturn(await this.getOrganisationSubnodes(dn, req))
        );
      }
    );

    /**
     * @openapi
     * summary: Search subnodes of an organization
     * description: |
     *   Full-text search across child OUs and linked entries (users, groups)
     *   of `:dn`. The `q` parameter is matched against `ou`, `description`,
     *   `uid`, `cn`, `sn`, `givenName`, and `mail`.
     *
     *   Matching attached entries are capped at
     *   `ldap_organization_max_subnodes` (default 50), and the same sentinel
     *   entries as `/subnodes` say when the answer is partial: a client must
     *   drop whatever carries `_isMoreIndicator` before treating the rest as
     *   entries.
     * parameters:
     *   - in: query
     *     name: q
     *     required: true
     *     schema: { type: string }
     *     description: Search query matched against common attributes.
     *     example: alice
     * responses:
     *   '200':
     *     description: Matching entries.
     *     content:
     *       application/json:
     *         schema:
     *           type: array
     *           items: { $ref: '#/components/schemas/OrgSummary' }
     *         example:
     *           - dn: uid=alice,ou=users,dc=example,dc=com
     *             uid: alice
     *             cn: Alice Smith
     *             mail: alice@example.com
     *   '400':
     *     description: Query parameter `q` missing.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Search in organization subnodes
    app.get(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn/subnodes/search`,
      asyncHandler(async (req, res) => {
        const dn = decodeURIComponent(req.params.dn as string);
        const query = req.query.q as string;
        if (!query)
          throw new BadRequestError('query parameter "q" is required');
        await tryMethodData(res, async () =>
          this.hideNeverReturn(
            await this.searchOrganisationSubnodes(dn, query, req)
          )
        );
      })
    );

    /**
     * @openapi
     * summary: Create organization
     * description: |
     *   Creates a new organizational unit. The `ou` field becomes the RDN.
     *   `parentDn` controls where in the tree the node is placed; it defaults
     *   to the configured top organization.
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/OrganizationCreate' }
     * responses:
     *   '200':
     *     description: Organization created.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '400':
     *     description: Validation error (missing `ou`, invalid DN value, …).
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '409':
     *     description: Organization already exists.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Add organization
    app.post(
      `${this.config.api_prefix}/v1/ldap/organizations`,
      asyncHandler(async (req, res) => this.apiAdd(req, res))
    );

    /**
     * @openapi
     * summary: Modify organization
     * description: |
     *   Partial attribute update. Each key in the body replaces the existing
     *   value for that attribute. The `ou` RDN and the organization path/link
     *   attributes cannot be changed through this endpoint.
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/OrganizationModify' }
     * responses:
     *   '200':
     *     description: Organization updated.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '400':
     *     description: Validation error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Organization not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Modify organization
    app.put(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn`,
      asyncHandler(async (req, res) => this.apiModify(req, res))
    );

    /**
     * @openapi
     * summary: Delete organization
     * description: |
     *   Deletes the organizational unit identified by `:dn`. The operation is
     *   rejected with **409 Conflict** when any entry still references this
     *   organization via the organization-link attribute (i.e. the OU is not
     *   empty).
     * responses:
     *   '200':
     *     description: Organization deleted.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '404':
     *     description: Organization not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '409':
     *     description: Organization is not empty.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Delete organization
    app.delete(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn`,
      asyncHandler(async (req, res) => this.apiDelete(req, res))
    );

    /**
     * @openapi
     * summary: Move organization to another parent
     * description: |
     *   Performs an LDAP `modifyDN` to relocate the organizational unit `:dn`
     *   under `targetOrgDn`. The new DN is returned in the response.
     *   Moving into a descendant or the current parent is rejected.
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         type: object
     *         required: [targetOrgDn]
     *         properties:
     *           targetOrgDn:
     *             type: string
     *             description: DN of the destination organizational unit.
     *       example:
     *         targetOrgDn: ou=divisions,ou=organizations,dc=example,dc=com
     * responses:
     *   '200':
     *     description: Organization moved. Returns the new DN.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             newDn: { type: string }
     *         example:
     *           newDn: ou=Engineering,ou=divisions,ou=organizations,dc=example,dc=com
     *   '400':
     *     description: Invalid target (circular move, same location, …).
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Source or target organization not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Move organization to a different parent
    app.post(
      `${this.config.api_prefix}/v1/ldap/organizations/:dn/move`,
      asyncHandler(async (req, res) => this.apiMove(req, res))
    );
  }

  async apiAdd(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res, 'ou') as
      | {
          ou: string;
          parentDn?: string;
          [key: string]: AttributeValue | undefined;
        }
      | false;
    if (!body) return;

    // The path and link attributes are the server's, as this endpoint's own
    // description says. Only the flat entities enforced it.
    assertClientMaySet(this.schema, Object.keys(body), 'ou');
    validateDnValue(body.ou, 'ou');
    const parentDn = body.parentDn || this.config.ldap_top_organization;
    const dn = `ou=${escapeDnValue(body.ou)},${parentDn}`;
    const entry: AttributesList = {
      objectClass: this.config.ldap_organization_class as string[],
      ou: body.ou,
      ...Object.fromEntries(
        Object.entries(body).filter(
          ([key]) => key !== 'ou' && key !== 'parentDn'
        )
      ),
    };

    await tryMethod(res, this.addOrganization.bind(this), dn, entry, req);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as ModifyRequest | false;
    if (!body) return;
    const dn = decodeURIComponent(req.params.dn as string);
    if (!dn) throw new BadRequestError('dn is required');
    assertClientMaySet(this.schema, modifiedAttributeNames(body));
    await tryMethod(res, this.modifyOrganization.bind(this), dn, body);
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const dn = decodeURIComponent(req.params.dn as string);
    if (!dn) throw new BadRequestError('dn is required');
    await tryMethod(res, this.deleteOrganization.bind(this), dn);
  }

  async apiMove(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const body = jsonBody(req, res, 'targetOrgDn') as
      | { targetOrgDn: string }
      | false;
    if (!body) return;

    const dn = decodeURIComponent(req.params.dn as string);
    if (!dn) throw new BadRequestError('dn is required');

    const { targetOrgDn } = body;

    if (!targetOrgDn || typeof targetOrgDn !== 'string') {
      throw new BadRequestError(
        'Missing or invalid targetOrgDn in request body'
      );
    }

    await tryMethodData(
      res,
      this.moveOrganization.bind(this),
      dn,
      targetOrgDn,
      req
    );
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
    ldapaddrequest: async ([dn, entry, req]) => {
      // Organizations use LDAP hierarchy (DN), not twakeDepartmentLink
      // Only users/groups have twakeDepartmentLink
      if (!this.isOu(entry)) {
        await this.checkDeptLink(entry);
      }
      // Only check path for organizations, not for users/groups
      if (this.isOu(entry)) await this.checkDeptPath(entry, dn);
      return req !== undefined
        ? [dn, entry, req]
        : ([dn, entry] as [string, AttributesList, Request?]);
    },

    // `req` travels with the tuple — see the note in plugins/ldap/onChange.
    ldapmodifyrequest: async ([dn, changes, op, req]) => {
      let fakeEntryL: AttributesList = {};
      let fakeEntryP: AttributesList = {};
      let isOrgEntry: boolean | undefined;

      // Determine if this is an organization entry
      const checkIsOu = async (): Promise<boolean> => {
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
        // By name, whatever its case and whatever value the object form pairs
        // with it: `{"twakeDepartmentPath": null}` removes the whole attribute.
        const deleted = (
          Array.isArray(changes.delete)
            ? changes.delete.map(String)
            : Object.keys(changes.delete)
        ).map(name => name.split(';')[0].toLowerCase());
        const hasLinkDelete = deleted.includes(this.linkAttr.toLowerCase());
        const hasPathDelete = deleted.includes(this.pathAttr.toLowerCase());

        if (hasLinkDelete || hasPathDelete) {
          const isOu = await checkIsOu();
          if (!isOu && hasLinkDelete) {
            throw new BadRequestError(`An organization link cannot be deleted`);
          }
          if (hasPathDelete) {
            throw new BadRequestError(`An organization path cannot be deleted`);
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
          await this.checkDeptPath(fakeEntryP, dn);
        }
      }
      return [dn, changes, op, req];
    },

    ldapdeleterequest: async ([dn, req]: [string | string[], Request?]) => {
      // Deletion of a non empty organization is forbidden
      const targets = Array.isArray(dn) ? dn : [dn];
      for (const target of targets) {
        if (/^ou=/.test(target)) await this.isEmptyOrganization(target);
      }
      return [dn, req] as [string | string[], Request?];
    },

    ldaprenamerequest: ([dn, newdn, req]) => {
      return [dn, newdn, req];
    },
  };

  /**
   * Check if the department link is valid
   * @param entry LDAP entry to check
   */
  async checkDeptLink(entry: AttributesList): Promise<void> {
    if (entry[this.linkAttr]) {
      const linkValue = entry[this.linkAttr];
      const orgDn = (
        Array.isArray(linkValue) ? linkValue[0] : linkValue
      ) as string;
      // Use scope: 'base' to benefit from LDAP cache
      const res = await this.server.ldap.search(
        { paged: false, scope: 'base' },
        orgDn
      );
      if ((res as SearchResult).searchEntries.length === 0)
        throw new NotFoundError(`Organization ${orgDn} does not exist`);
      if (
        !new RegExp(`(.*,)?${this.config.ldap_top_organization}`).test(
          (res as SearchResult).searchEntries[0].dn
        )
      )
        throw new BadRequestError(
          `Entry ${orgDn} isn't in top organization branch`
        );
    }
  }

  /**
   * Check if the department path is valid
   *
   * @param entry LDAP entry to check
   * @param dn DN the entry is written at, when the caller knows it. It is
   *   what says whether the entry is an organization and where it hangs
   *   from; a modify carries the changed attributes alone, neither `ou` nor
   *   `objectClass`, so without it the invariants below cannot be checked.
   */
  async checkDeptPath(entry: AttributesList, dn?: string): Promise<void> {
    if (entry[this.pathAttr]) {
      const pathValue = entry[this.pathAttr];
      const path = (
        Array.isArray(pathValue) ? pathValue[0] : pathValue
      ) as string;
      const sep = this.config.ldap_organization_path_separator || ' / ';
      const topOrg = (this.config.ldap_top_organization as string) || '';

      // An organization, told from its DN: an `ou=` entry inside the top
      // organization branch. The payload says so too on a creation, and says
      // nothing at all on a modify.
      const nameFromDn =
        dn && topOrg && /^ou=/i.test(getRdn(dn)) && isDnInBranch(dn, topOrg)
          ? rdnValue(dn)
          : undefined;
      const ouValue = entry.ou;
      const ouName =
        ((Array.isArray(ouValue) ? ouValue[0] : ouValue) as
          | string
          | undefined) || nameFromDn;

      let matchingPath = path;
      if ((this.isOu(entry) || nameFromDn !== undefined) && ouName) {
        // Directories written before the order was settled hold the reverse
        // path, the entry's own name first and the top organization's own
        // name last (`TestOrg / organization`). The server never computes
        // that any more, but it is what those directories contain, and
        // refusing it would make every organization of theirs unwritable on
        // an upgrade. The stored form is taken as it stands; only what the
        // server computes has to follow the new convention.
        const topName = topOrg ? rdnValue(topOrg) : '';
        if (
          topName &&
          path.startsWith(ouName + sep) &&
          path.endsWith(sep + topName)
        )
          return;

        // A path reads from the root down: `Root / Branch / Leaf`, the
        // entry's own name last. This asked for the reverse, so it refused
        // every path the directories it serves actually hold.
        if (path === ouName) {
          // A path that is only the entry's own name says it hangs straight
          // from the top organization. That is not the payload's word to
          // give: an organization anywhere lower would keep a path naming
          // none of its parents, against the very invariant this checks. The
          // DN settles it, when the caller passed one — and it settles
          // nothing for an `ou=` entry outside the organization tree, whose
          // path names no place in a hierarchy this check can read.
          const top = topOrg ? normalizeDn(topOrg) : '';
          if (
            !dn ||
            !top ||
            !isDnInBranch(dn, topOrg) ||
            normalizeDn(dn) === top ||
            normalizeDn(getParentDn(dn)) === top
          )
            return;
          throw new BadRequestError(
            `Organization path "${path}" names no parent, but ${dn} is not directly under ${topOrg}`
          );
        }
        if (!path.endsWith(sep + ouName))
          throw new BadRequestError(
            `Organization path must end with its own name, preceded by separator "${sep}"`
          );
        matchingPath = path.slice(0, path.length - sep.length - ouName.length);
      }

      // What is left is the path of the organization this entry hangs from:
      // the parent for an organization, the department itself for anything
      // else. It has to be a path some organization actually holds — walking
      // the chain element by element was both more work and wrong past two
      // levels, since it compared an ancestor's name against its own
      // ancestors' path.
      const entries = (await this.server.ldap.search(
        {
          paged: false,
          scope: 'sub',
          filter: `(${this.pathAttr}=${escapeLdapFilter(matchingPath)})`,
          attributes: ['dn'],
        },
        this.config.ldap_top_organization
      )) as SearchResult;
      if (!entries.searchEntries || entries.searchEntries.length === 0)
        throw new BadRequestError(
          `Invalid organization path ${path}: no organization holds "${matchingPath}"`
        );
    }
  }

  async isEmptyOrganization(dn: string): Promise<void> {
    const res = await this.server.ldap.search({
      paged: false,
      filter: `(${this.config.ldap_organization_link_attribute}=${escapeLdapFilter(dn)})`,
    });
    if ((res as SearchResult).searchEntries.length > 0)
      throw new ConflictError(`Organization ${dn} is not empty`);
  }

  /**
   * Check if entry is an organisation
   * @param entry LDAP entry to check
   * @returns True if entry is an organisation, false otherwise
   */
  isOu(entry: AttributesList): boolean {
    if (!entry.objectClass) return false;
    const entryClasses = (entry.objectClass as string[]).map(c =>
      c.toLowerCase()
    );
    return (this.config.ldap_organization_class as string[])
      .filter(c => c.toLowerCase() !== 'top')
      .some(c => entryClasses.includes(c.toLowerCase()));
  }

  async getOrganisationTop(
    req?: Request
  ): Promise<AttributesList | AttributesList[]> {
    if (!this.config.ldap_top_organization)
      throw new BadRequestError('No top organization configured');

    // Get default top organization
    const top = await this.server.ldap.search(
      { paged: false, scope: 'base' },
      this.config.ldap_top_organization,
      req
    );
    if ((top as SearchResult).searchEntries.length !== 1)
      throw new NotFoundError('Top organization not found');

    // Call hook to allow plugins (like authzPerBranch) to modify the result
    const [, result] = await launchHooksChained(
      this.registeredHooks.getOrganisationTop,
      [req, (top as SearchResult).searchEntries[0]]
    );

    return result;
  }

  async getOrganisationByDn(
    dn: string,
    req?: Request
  ): Promise<AttributesList> {
    const org = await this.server.ldap.search(
      {
        paged: false,
        scope: 'base',
        filter: '(objectClass=organizationalUnit)',
      },
      dn,
      req
    );
    if ((org as SearchResult).searchEntries.length !== 1)
      throw new NotFoundError(`Organization ${dn} not found`);
    return (org as SearchResult).searchEntries[0];
  }

  async getOrganisationSubnodes(
    dn: string,
    req?: Request
  ): Promise<AttributesList[]> {
    const result: AttributesList[] = [];
    const MAX_LINKED_ENTITIES =
      this.config.ldap_organization_max_subnodes || 50;

    // Check if objectClass filter is requested via query parameter
    const objectClassFilter = req?.query?.objectClass as string | undefined;

    // 1. Get direct sub-OUs (children organizational units)
    if (!objectClassFilter || objectClassFilter === 'organizationalUnit') {
      result.push(
        ...(await this.childOrganizations(
          dn,
          '(objectClass=organizationalUnit)',
          MAX_LINKED_ENTITIES,
          req
        ))
      );
    }

    // 2. Get linked entities (users and groups) - limited to MAX_LINKED_ENTITIES
    // Need to search from LDAP base, not just organization tree
    // (e.g., "dc=example,dc=com" from "ou=organizations,dc=example,dc=com")
    const topOrg = this.config.ldap_top_organization as string;
    const baseDn = getParentDn(topOrg);
    let filter = `(${this.config.ldap_organization_link_attribute}=${escapeLdapFilter(
      dn
    )})`;

    // Add objectClass filter if specified
    if (objectClassFilter) {
      filter = `(&${filter}(objectClass=${escapeLdapFilter(
        objectClassFilter
      )}))`;
    }

    this.server.logger.debug(
      `Searching for linked entities with filter: ${filter} in ${baseDn}`
    );
    result.push(
      ...(await this.linkedEntities(
        baseDn,
        filter,
        MAX_LINKED_ENTITIES,
        dn,
        req
      ))
    );

    return result;
  }

  /** Nodes already warned about, so a crowded tree says it once per node. */
  private sizeLimitWarned = new Set<string>();
  /** How many of them to remember. */
  private static readonly SIZE_LIMIT_WARNED_MAX = 500;

  /**
   * Say once per node what only the directory can fix.
   *
   * A console expanding a tree lists the same crowded node on every refresh,
   * and a warning per listing buries the rest of the log while saying
   * nothing new: the answer stays partial until someone raises the size
   * limit. The first listing carries the message, the others go to `debug`.
   *
   * The set is bounded, so a directory with thousands of crowded nodes
   * cannot grow it without end. Past the bound the message is written every
   * time — the loud side of the trade rather than the silent one.
   *
   * @param key node the message is about
   * @param message what to say
   */
  private warnSizeLimit(key: string, message: string): void {
    if (this.sizeLimitWarned.has(key)) {
      this.server.logger.debug(message);
      return;
    }
    if (this.sizeLimitWarned.size < LdapOrganizations.SIZE_LIMIT_WARNED_MAX)
      this.sizeLimitWarned.add(key);
    this.server.logger.warn(message);
  }

  /**
   * The child organizations of a node, and what to do when the directory
   * will not list them all.
   *
   * Every failure used to be read as "no children" (#179): the node's own
   * children were searched without a limit, and a directory answering
   * `sizeLimitExceeded` rather than a long list left the endpoint returning
   * `200 []` with nothing above `debug` to say so. An empty tree is what a
   * console then draws for a branch holding a thousand organizations.
   *
   * Three outcomes, and only one of them is emptiness:
   *
   *  - `noSuchObject` (32): nothing is there. An empty answer is the truth.
   *  - `sizeLimitExceeded` (4): the answer was longer than the server's
   *    limit. Measured against OpenLDAP 2.5, the paged control does not lift
   *    it — `size.prtotal` bounds the whole search, so a paged walk ends on
   *    the same refusal. What does change the answer is asking for a bounded
   *    number: ldapts raises the refusal only when the request carried no
   *    `sizeLimit` of its own, so a second, bounded search comes back with
   *    entries where the first came back with an error. The answer then says
   *    it is partial, through the `moreIndicator` row the attached entries
   *    already use.
   *  - anything else is a failure, and answering `[]` to a failure is how a
   *    broken directory comes to look exactly like an empty one.
   *
   * The first search is paged for the directories where paging *is* what
   * lifts the limit: Active Directory answers an unpaged search with at most
   * `MaxPageSize` entries and expects the control for the rest.
   *
   * @param dn organization whose children are wanted
   * @param filter what those children have to match
   * @param cap how many to keep when the directory will not list them all
   * @param req incoming request, forwarded to the authorization hooks
   * @returns the children, followed by a `moreIndicator` row when the
   *          directory refused to list them all
   */
  private async childOrganizations(
    dn: string,
    filter: string,
    cap: number,
    req?: Request
  ): Promise<AttributesList[]> {
    try {
      const pages = (await this.server.ldap.search(
        { paged: true, scope: 'one', filter },
        dn,
        req
      )) as AsyncGenerator<SearchResult>;
      const children: AttributesList[] = [];
      // A paged search fails from the walk, not from the call above: the
      // generator reaches the directory on its first iteration. One try
      // covers both.
      for await (const page of pages) children.push(...page.searchEntries);
      this.server.logger.debug(`Found ${children.length} sub-OUs for ${dn}`);
      return children;
    } catch (err) {
      const code = extractLdapCode(err);
      if (code === 32) {
        this.server.logger.debug(`No sub-OUs for ${dn}: the node holds none`);
        return [];
      }
      if (code !== 4) throw err;
    }

    // Refused for being too long. Ask again for a bounded number, which the
    // directory answers instead of refusing.
    const bounded = (await this.server.ldap.search(
      { paged: false, scope: 'one', filter, sizeLimit: cap + 1 },
      dn,
      req
    )) as SearchResult;
    const shown = bounded.searchEntries.slice(0, cap);
    // `warn`, not `debug`: the answer is incomplete, and the only fix is on
    // the directory. Nothing else in the response says so to an operator
    // reading logs — but once per node, not once per listing.
    this.warnSizeLimit(
      `children:${dn}`,
      `Organization ${dn} holds more child organizations than the directory ` +
        `will list in one answer, so ${shown.length} are returned and the ` +
        'rest are hidden. Raise the size limit for the account ldap-rest ' +
        'binds as (olcLimits, or olcSizeLimit) to list them all.'
    );
    return [
      ...shown,
      {
        // Distinct from the row the attached entries add: one answer can
        // carry both, and two rows sharing a DN is not a list.
        dn: `more-organizations-${dn}`,
        cn: ['... more organizations than the directory will list'],
        objectClass: ['moreIndicator'],
        _isMoreIndicator: 'true',
        _displayedCount: shown.length.toString(),
      },
    ];
  }

  /**
   * The entries attached to an organization without being one.
   *
   * Capped at `cap`, with a `moreIndicator` row counting what was left out —
   * the behaviour this endpoint already had, plus the refusal the children
   * search just learned to survive: a directory that will not walk the whole
   * link filter is told about rather than turned into an empty list.
   *
   * @param baseDn branch the attached entries live in
   * @param filter what links them to the organization
   * @param cap how many to return
   * @param dn organization they are attached to, for the indicator's DN
   * @param req incoming request, forwarded to the authorization hooks
   * @returns the entries, followed by a `moreIndicator` row when some were
   *          left out
   */
  private async linkedEntities(
    baseDn: string,
    filter: string,
    cap: number,
    dn: string,
    req?: Request
  ): Promise<AttributesList[]> {
    const kept: AttributesList[] = [];
    let totalCount = 0;
    try {
      const subs = (await this.server.ldap.search(
        { paged: true, filter },
        baseDn,
        req
      )) as AsyncGenerator<SearchResult>;
      for await (const sub of subs) {
        totalCount += sub.searchEntries.length;
        const remaining = cap - kept.length;
        if (remaining > 0) kept.push(...sub.searchEntries.slice(0, remaining));
      }
    } catch (err) {
      const code = extractLdapCode(err);
      // `noSuchObject` is not answered with an empty list here, where it is
      // for the children. The base is not the caller's node but the branch
      // the deployment configured — the parent of `ldap_top_organization` —
      // and its absence is a configuration nobody can act on from an empty
      // answer. It keeps raising, as before this change.
      if (code !== 4) throw err;
      const bounded = (await this.server.ldap.search(
        { paged: false, filter, sizeLimit: cap + 1 },
        baseDn,
        req
      )) as SearchResult;
      this.warnSizeLimit(
        `linked:${dn}`,
        `More entries are attached to ${dn} than the directory will list in ` +
          'one answer. Raise the size limit for the account ldap-rest binds ' +
          'as (olcLimits, or olcSizeLimit) to count them all.'
      );
      return [
        ...bounded.searchEntries.slice(0, cap),
        {
          dn: `more-${dn}`,
          cn: ['... more elements than the directory will list'],
          objectClass: ['moreIndicator'],
          _isMoreIndicator: 'true',
          _displayedCount: Math.min(
            bounded.searchEntries.length,
            cap
          ).toString(),
        },
      ];
    }

    this.server.logger.debug(
      `Found ${totalCount} linked entities for ${dn}, returning ${kept.length}`
    );
    if (totalCount <= cap) return kept;
    return [
      ...kept,
      {
        dn: `more-${dn}`,
        cn: [`... ${totalCount - cap} more elements`],
        objectClass: ['moreIndicator'],
        _isMoreIndicator: 'true',
        _totalCount: totalCount.toString(),
        _displayedCount: cap.toString(),
      },
    ];
  }

  async addOrganization(
    dn: string,
    entry: AttributesList,
    req?: Request
  ): Promise<boolean> {
    // Validate with schema if available
    await this.validateNewOrganization(dn, entry);
    // Hooks will validate the organization link and path
    return await this.server.ldap.add(dn, entry, req);
  }

  async modifyOrganization(
    dn: string,
    changes: ModifyRequest
  ): Promise<boolean> {
    // Validate with schema if available
    await this.validateChanges(dn, changes);
    // Hooks will validate any changes to organization link and path
    return await this.server.ldap.modify(dn, changes);
  }

  async validateNewOrganization(
    dn: string,
    entry: AttributesList
  ): Promise<boolean> {
    if (!this.schema) return true;

    // Check each field
    for (const [field, value] of Object.entries(entry)) {
      if (!(await this._validateOneChange(field, value))) {
        throw new BadRequestError(this.invalidValueMessage(field));
      }
    }

    // Check required fields. A `generated` attribute is exempt — it is filled
    // by a hook after validation, so demanding it here would refuse the very
    // payload the hook expects — but only when a loaded plugin says it will
    // fill it. Exempting it unconditionally wrote an organization missing the
    // path its own schema calls required, which no client could ever repair:
    // a generated attribute is refused as input. Same check as the flat path.
    const missing = missingRequiredAttribute(
      this.schema,
      entry,
      this.server.loadedPlugins
    );
    if (missing) throw new BadRequestError(`Missing required field ${missing}`);
    return true;
  }

  /**
   * Build the rejection message for a value that failed its schema `test`,
   * quoting the `hint` when the schema carries one so the answer says what a
   * valid value looks like.
   *
   * @param field attribute name
   * @returns message for a `BadRequestError`
   */
  invalidValueMessage(field: string): string {
    const attr = this.schema?.attributes[field];
    const hint = attr?.hint || attr?.items?.hint;
    return hint
      ? `Invalid value for field ${field}: ${hint}`
      : `Invalid value for field ${field}`;
  }

  async validateChanges(dn: string, changes: ModifyRequest): Promise<boolean> {
    if (!this.schema) return true;

    if (changes.add) {
      for (const [field, value] of Object.entries(changes.add)) {
        if (!(await this._validateOneChange(field, value))) {
          throw new BadRequestError(this.invalidValueMessage(field));
        }
      }
    }

    if (changes.replace) {
      for (const [field, value] of Object.entries(changes.replace)) {
        if (!(await this._validateOneChange(field, value))) {
          throw new BadRequestError(this.invalidValueMessage(field));
        }
      }
    }

    return true;
  }

  async _validateOneChange(
    field: string,
    value: AttributeValue | null
  ): Promise<boolean> {
    if (!this.schema) return true;
    // Every refusal here is the client's value, so a 400: a plain Error
    // reached the client as a 500 "check logs", which also left the hint-
    // quoting message of the callers unreachable.
    const fieldTest = this.schema.attributes[field];
    if (!fieldTest) {
      if (this.schema.strict)
        throw new BadRequestError(`Field ${field} is not allowed`);
      return true;
    }
    if (value === null || value === undefined) {
      if (fieldTest.required)
        throw new BadRequestError(`Field ${field} is required`);
      return true;
    }

    // A single-valued attribute takes one value. A multi-valued one takes one
    // value or several, as on the flat routes and in LDAP itself: requiring a
    // list refused, with a 500, the string an existing client still sends for
    // an attribute a schema turned into an array (`telephoneNumber`).
    if (fieldTest.type === 'string' && Array.isArray(value))
      throw new BadRequestError(`Field ${field} must be a single value`);

    await checkDnValues(field, fieldTest, value, dn => this.entryExists(dn));
    return matchesPattern(fieldTest, value);
  }

  /**
   * Tell whether a DN names an existing entry.
   *
   * @param dn DN to look up
   * @returns true when the directory holds it
   */
  private async entryExists(dn: string): Promise<boolean> {
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['dn'] },
        dn
      )) as SearchResult;
      return result.searchEntries.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Move an organization to a different parent organization
   * Uses LDAP modifyDN to change the DN hierarchy
   */
  async moveOrganization(
    dn: string,
    targetOrgDn: string,
    req?: Request
  ): Promise<{ newDn: string }> {
    // Validate that target organization exists.
    // ldap.search throws on NoSuchObject; treat both that and an empty
    // result set as "not found" (404).
    let targetOrg: SearchResult;
    try {
      targetOrg = (await this.server.ldap.search(
        { paged: false, scope: 'base' },
        targetOrgDn
      )) as SearchResult;
    } catch (err) {
      throw new NotFoundError(
        `Target organization ${targetOrgDn} not found: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!targetOrg.searchEntries || targetOrg.searchEntries.length === 0) {
      throw new NotFoundError(`Target organization ${targetOrgDn} not found`);
    }
    if (!this.isOu(targetOrg.searchEntries[0])) {
      throw new BadRequestError(
        `Target ${targetOrgDn} is not an organizational unit`
      );
    }

    // Extract the RDN (relative DN) from the source DN
    // e.g., "ou=IT,ou=Departments,dc=example,dc=com" -> "ou=IT"
    const rdn = getRdn(dn);

    // Construct the new DN
    const newDn = `${rdn},${targetOrgDn}`;

    // Verify the organization to move exists
    let sourceOrg: SearchResult;
    try {
      sourceOrg = (await this.server.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new NotFoundError(`Source organization not found: ${err}`);
    }
    if (!sourceOrg.searchEntries || sourceOrg.searchEntries.length === 0) {
      throw new NotFoundError(`Source organization ${dn} not found`);
    }

    // Prevent moving to itself or creating circular references
    if (newDn === dn) {
      throw new BadRequestError(
        'Cannot move organization to its current location'
      );
    }
    // Reject moving into self or any descendant (case-insensitive DN compare)
    if (
      targetOrgDn.toLowerCase() === dn.toLowerCase() ||
      isChildOf(targetOrgDn, dn)
    ) {
      throw new BadRequestError(
        'Cannot move organization into itself or its descendant'
      );
    }

    // Perform the LDAP modifyDN operation
    try {
      await this.server.ldap.rename(dn, newDn, req);
      this.logger.info(`Moved organization from ${dn} to ${newDn}`);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to move organization: ${err}`);
    }

    return { newDn };
  }

  async deleteOrganization(dn: string): Promise<boolean> {
    // Hook will check that organization is empty before deletion
    return await this.server.ldap.delete(dn);
  }

  /**
   * The same two searches as `getOrganisationSubnodes`, narrowed by a query.
   *
   * Both go through the helpers that classify a failure rather than reading
   * every one of them as emptiness (#179), and both now carry the request:
   * they ran without one, and an authorization plugin skips its check when
   * there is none — the same gap the flat routes had until 0.8.2. The
   * attached entries are capped like the other endpoint's, since an answer
   * the directory refuses to finish is what this is about.
   *
   * @param dn organization to search under
   * @param query what to look for in a name, a description or an identity
   * @param req incoming request, forwarded to the authorization hooks
   * @returns matching organizations then matching attached entries
   */
  async searchOrganisationSubnodes(
    dn: string,
    query: string,
    req?: Request
  ): Promise<AttributesList[]> {
    const result: AttributesList[] = [];
    const cap = this.config.ldap_organization_max_subnodes || 50;

    // Search for sub-OUs matching the query
    // Escape query to prevent LDAP injection
    const escapedQuery = escapeLdapFilter(query);
    result.push(
      ...(await this.childOrganizations(
        dn,
        `(&(objectClass=organizationalUnit)(|(ou=*${escapedQuery}*)(description=*${escapedQuery}*)))`,
        cap,
        req
      ))
    );

    // Search for linked entities (users and groups) matching the query
    const topOrg = this.config.ldap_top_organization as string;
    const baseDn = getParentDn(topOrg);
    // Escape both dn and query to prevent LDAP injection
    const escapedDn = escapeLdapFilter(dn);
    const filter = `(&(${this.config.ldap_organization_link_attribute}=${escapedDn})(|(uid=*${escapedQuery}*)(cn=*${escapedQuery}*)(mail=*${escapedQuery}*)(sn=*${escapedQuery}*)(givenName=*${escapedQuery}*)))`;
    this.server.logger.debug(
      `Searching for linked entities with filter: ${filter} in ${baseDn}`
    );
    result.push(...(await this.linkedEntities(baseDn, filter, cap, dn, req)));

    return result;
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const apiPrefix = this.config.api_prefix || '/api';

    // Generate schema URL if static plugin is loaded
    let schemaUrl: string | undefined;
    if (
      this.server.loadedPlugins['static'] &&
      this.config.organization_schema
    ) {
      const staticName = this.config.static_name || 'static';
      const schemasIndex = this.config.organization_schema.indexOf('/schemas/');
      if (schemasIndex !== -1) {
        const relativePath =
          this.config.organization_schema.substring(schemasIndex);
        schemaUrl = `/${staticName}${relativePath}`;
      }
    }

    return {
      enabled: true,
      topOrganization: this.config.ldap_top_organization || '',
      organizationClass: this.config.ldap_organization_class || [
        'top',
        'organizationalUnit',
      ],
      linkAttribute: this.linkAttr || '',
      pathAttribute: this.pathAttr || '',
      pathSeparator: this.config.ldap_organization_path_separator || ' / ',
      maxSubnodes: this.config.ldap_organization_max_subnodes || 50,
      schema: this.schema,
      schemaUrl,
      endpoints: {
        getTop: `${apiPrefix}/v1/ldap/organizations/top`,
        get: `${apiPrefix}/v1/ldap/organizations/:dn`,
        getSubnodes: `${apiPrefix}/v1/ldap/organizations/:dn/subnodes`,
        searchSubnodes: `${apiPrefix}/v1/ldap/organizations/:dn/subnodes/search`,
        create: `${apiPrefix}/v1/ldap/organizations`,
        update: `${apiPrefix}/v1/ldap/organizations/:dn`,
        move: `${apiPrefix}/v1/ldap/organizations/:dn/move`,
        delete: `${apiPrefix}/v1/ldap/organizations/:dn`,
      },
    };
  }
}
