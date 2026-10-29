/**
 * @module plugins/ldap/groups
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Plugin to manage groups into LDAP server
 * - add/delete groups
 * - add/delete members of groups
 * - detect user deletion to remove them from groups (hook)
 */
import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type ldapActions from '../../lib/ldapActions';
import type {
  AttributesList,
  AttributeValue,
  LdapList,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import { assertModifyRequest } from '../../lib/ldapActions';
import {
  jsonBody,
  ok,
  tryMethod,
  wantJson,
} from '../../lib/expressFormatedResponses';
import { extractLdapCode } from '../../lib/ldapCodes';
import { loadSchemaFileAsync } from '../../lib/schemaFile';
import { staticSchemaUrl } from '../../lib/staticFiles';
import {
  asyncHandler,
  assertedRdnValue,
  escapeDnValue,
  escapeLdapFilter,
  isAuthzRefusal,
  getRdn,
  isDnInBranch,
  isDnSyntax,
  isDummyMemberDn,
  launchHooks,
  normalizeDn,
  launchHooksChained,
  movedToTrash,
  organizationLink,
  substringSearchFilter,
  validateDnValue,
} from '../../lib/utils';
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
} from '../../lib/errors';
import type { Schema } from '../../config/schema';
import {
  assertClientMaySet,
  modifiedAttributeNames,
  toDirectoryEntry,
} from '../../config/schema';
import {
  applyFixedDefaults,
  EntityValidator,
} from '../../lib/entitySchema/validator';

export interface postAdd {
  cn?: string;
  [key: string]: AttributeValue | undefined;
}
export type postModify = ModifyRequest;

/**
 * Shared OpenAPI schemas surfaced by this plugin. Picked up by
 * scripts/generate-openapi.ts and merged into `components.schemas`.
 *
 * @openapi-component
 * Group:
 *   type: object
 *   description: An LDAP group entry (groupOfNames / groupOfUniqueNames).
 *   required: [dn, cn]
 *   properties:
 *     dn:
 *       type: string
 *       description: Fully-qualified distinguished name of the entry.
 *       example: cn=admins,ou=groups,dc=example,dc=com
 *     cn:
 *       type: string
 *       description: Common name (RDN attribute) of the group.
 *       example: admins
 *     description:
 *       type: string
 *       example: Server administrators
 *     member:
 *       type: array
 *       items: { type: string }
 *       description: DNs of the group's members.
 *       example:
 *         - uid=alice,ou=users,dc=example,dc=com
 *         - uid=bob,ou=users,dc=example,dc=com
 * GroupCreate:
 *   type: object
 *   required: [cn]
 *   properties:
 *     cn:
 *       type: string
 *       description: Common name of the new group.
 *     description:
 *       type: string
 *     member:
 *       type: array
 *       items: { type: string }
 *       description: Initial members (DNs).
 *   example:
 *     cn: admins
 *     description: Server administrators
 *     member:
 *       - uid=alice,ou=users,dc=example,dc=com
 * GroupModify:
 *   type: object
 *   description: |
 *     Partial update. Each provided attribute is replaced wholesale. Use
 *     the dedicated `/members` endpoints to add/remove members one at a
 *     time without supplying the full list.
 *   properties:
 *     description: { type: string }
 *     member:
 *       type: array
 *       items: { type: string }
 *   example:
 *     description: Updated description
 * Error:
 *   type: object
 *   required: [error]
 *   properties:
 *     error:
 *       type: string
 *       description: What was refused, in English.
 *     code:
 *       type: string
 *       description: |
 *         For a client to explain the refusal in its own words, when there
 *         is one: `unique` (a value already used), `mailDomain` (an address
 *         outside the authorised mail domains), `forbidden` (the caller may
 *         not act on this branch). Absent for any other refusal, which only
 *         `error` describes. The Twake groups API answers its own codes
 *         (`INVALID_INPUT`, `REFUSED`…).
 *     attribute:
 *       type: string
 *       description: The attribute refused, for `unique` and `mailDomain`.
 *     value:
 *       type: string
 *       description: The value refused, for `unique` and `mailDomain`.
 *     domains:
 *       type: array
 *       items: { type: string }
 *       description: The authorised mail domains, for `mailDomain`.
 *   example:
 *     error: 'entity: "value" is already used (attribute must be unique)'
 *     code: unique
 *     attribute: attribute
 *     value: value
 */
export default class LdapGroups extends DmPlugin {
  name = 'ldapGroups';
  roles: Role[] = ['api', 'configurable'] as const;
  base?: string;
  ldap: ldapActions;
  cn: string;
  schema?: Schema;

  constructor(server: DM) {
    super(server);
    this.ldap = server.ldap;
    this.base = this.config.ldap_group_base as string;
    this.cn = this.config.ldap_groups_main_attribute as string;
    if (!this.base) {
      this.base = this.config.ldap_base;
      this.logger.warn(`LDAP group base is not defined, using "${this.base}"`);
    }
    if (!this.base) {
      throw new Error('LDAP base is not defined, please set --ldap-group-base');
    }
    // Not on the fallback: groups would then be declared for the whole
    // directory, and any entry outside the other bases given their classes.
    if (this.config.ldap_group_base)
      server.ldap.declareObjectClasses(
        this.base,
        (this.config.group_class as string[]) || []
      );
    if (this.config.group_schema) {
      const file = this.config.group_schema;
      loadSchemaFileAsync<Schema>(file, { config: this.config })
        .then(schema => {
          this.schema = this.adaptSchema(schema);
          this.server.ldap.knowAttributeNames(
            Object.keys(this.schema.attributes)
          );
          this.logger.debug('Group schema loaded');
        })
        .catch(err =>
          this.logger.error(`Failed to load group schema from ${file}: ${err}`)
        );
    }
  }

  /**
   * The loaded group schema, before it is used: a subclass declares there
   * the attributes it writes.
   */
  protected adaptSchema(schema: Schema): Schema {
    return schema;
  }

  /**
   * Remove deleted entries from groups once the delete has landed: a delete
   * refused, failed or turned into something else by another plugin leaves
   * the memberships alone — except a move into the trash, which frees the DN
   * all the same.
   */
  hooks: Hooks = {
    ldapdeletedone: async (dn: string | string[]) => {
      const dns = Array.isArray(dn) ? dn : [dn];
      this.logger.debug(
        `User deletion detected, removing from groups: ${dns.join(', ')}`
      );
      await Promise.all(
        dns.map(entry => this.deleteMemberFromAll(entry))
      ).catch(err => {
        this.logger.error('Failed to process user deletion in groups:', err);
      });
    },

    ldaprenamedone: async ([oldDn, newDn]) => {
      if (!movedToTrash(this.config.trash_base, oldDn, newDn)) return;
      await this.deleteMemberFromAll(oldDn).catch(err => {
        this.logger.error(
          'Failed to process a move to the trash in groups:',
          err
        );
      });
    },
  };

  /**
   * API routes
   */

  api(app: Express): void {
    /**
     * @openapi
     * summary: List groups
     * description: |
     *   Returns every group under the configured group base. The optional
     *   `match` query is matched against the attributes named by
     *   `attribute`, as a substring — the same semantics as the flat entity
     *   lists. Without `attribute` it is either a raw LDAP filter (when it
     *   contains `=`) or an exact value of the RDN attribute.
     * parameters:
     *   - in: query
     *     name: match
     *     schema: { type: string }
     *     description: Substring to look for, LDAP filter, or exact value.
     *     example: admin
     *   - in: query
     *     name: attribute
     *     schema: { type: string }
     *     description: |
     *       LDAP attribute name to match `match` against, as a substring.
     *       Several may be given, separated by commas; a group matching any
     *       of them is returned. Each name must be indexed for a substring
     *       search, or the directory scans the branch.
     *     example: cn,mail
     *   - in: query
     *     name: attributes
     *     schema: { type: string }
     *     description: Comma-separated list of attributes to return.
     *     example: cn,description,member
     * responses:
     *   '200':
     *     description: Group list.
     *     content:
     *       application/json:
     *         schema:
     *           type: array
     *           items: { $ref: '#/components/schemas/Group' }
     *         example:
     *           - dn: cn=admins,ou=groups,dc=example,dc=com
     *             cn: admins
     *             description: Server administrators
     *             member:
     *               - uid=alice,ou=users,dc=example,dc=com
     *           - dn: cn=editors,ou=groups,dc=example,dc=com
     *             cn: editors
     *             description: Content editors
     *             member: []
     *   '400':
     *     description: Invalid `match` query.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // List groups
    app.get(
      `${this.config.api_prefix}/v1/ldap/groups`,
      asyncHandler(async (req, res) => {
        if (!wantJson(req, res)) return;
        const args: { filter?: string; attributes?: string[] } = {};
        if (req.query.match) {
          if (typeof req.query.match !== 'string') {
            throw new BadRequestError('Invalid match query');
          }
          if (typeof req.query.attribute === 'string' && req.query.attribute) {
            // The client named what it is searching in, so search in it — as
            // a substring, as the flat lists do. Building the filter on the
            // RDN attribute whatever was asked answered "no entry matches"
            // to every search by mail address the console sends.
            args.filter = substringSearchFilter(
              req.query.match,
              req.query.attribute
            );
          } else if (/=/.test(req.query.match)) {
            // Custom filter syntax - validate strictly to prevent LDAP injection
            // A client asks for `(member=<DN>)`, and a DN holds `.`, `@` and
            // `'`. `\` stays refused: it escapes in a filter. The allowed set
            // is in docs/usage/plugins/ldap/groups.md.
            if (!/^[\w*=()&|, .@'-]+$/.test(req.query.match)) {
              throw new BadRequestError(
                'Invalid match query: contains forbidden characters'
              );
            }
            // Use as-is (backward compatibility for advanced queries)
            args.filter = req.query.match;
          } else {
            // Simple value - escape to prevent LDAP injection
            const escapedMatch = escapeLdapFilter(req.query.match);
            args.filter = `(${this.cn}=${escapedMatch})`;
          }
        }
        if (req.query.attributes && typeof req.query.attributes === 'string')
          args.attributes = req.query.attributes.split(',');
        const list = await this.listGroups({ ...args, req });
        return ok(res, this.hideNeverReturn(list));
      })
    );

    /**
     * @openapi
     * summary: Get group by CN
     * description: |
     *   The `:cn` segment may be either the group's RDN value (e.g.
     *   `admins`) or its full DN. Returns the raw LDAP entry.
     * responses:
     *   '200':
     *     description: Group entry.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Group' }
     *         example:
     *           dn: cn=admins,ou=groups,dc=example,dc=com
     *           cn: admins
     *           description: Server administrators
     *           member:
     *             - uid=alice,ou=users,dc=example,dc=com
     *   '404':
     *     description: Group not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Get group by cn or DN
    app.get(
      `${this.config.api_prefix}/v1/ldap/groups/:cn`,
      asyncHandler(async (req, res) => this.apiGet(req, res))
    );

    /**
     * @openapi
     * summary: Create group
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/GroupCreate' }
     * responses:
     *   '200':
     *     description: Group created.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '400':
     *     description: Validation error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Add group
    app.post(
      `${this.config.api_prefix}/v1/ldap/groups`,
      asyncHandler(async (req, res) => this.apiAdd(req, res, this.cn))
    );

    /**
     * @openapi
     * summary: Delete group
     * responses:
     *   '200':
     *     description: Group deleted.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '404':
     *     description: Group not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Delete group
    app.delete(
      `${this.config.api_prefix}/v1/ldap/groups/:cn`,
      asyncHandler(async (req, res) => this.apiDelete(req, res))
    );

    /**
     * @openapi
     * summary: Modify group
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/GroupModify' }
     * responses:
     *   '200':
     *     description: Group updated.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '404':
     *     description: Group not found.
     */
    // Modify group
    app.put(
      `${this.config.api_prefix}/v1/ldap/groups/:cn`,
      asyncHandler(async (req, res) => this.apiModify(req, res))
    );

    /**
     * @openapi
     * summary: Add members to group
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         type: object
     *         required: [member]
     *         properties:
     *           member:
     *             oneOf:
     *               - type: string
     *               - type: array
     *                 items: { type: string }
     *             description: One DN or a list of DNs to add.
     *       example:
     *         member:
     *           - uid=carol,ou=users,dc=example,dc=com
     *           - uid=dave,ou=users,dc=example,dc=com
     * responses:
     *   '200':
     *     description: Members added.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '400':
     *     description: A member does not exist or is not a DN; none is added.
     */
    // Add member to group
    app.post(
      `${this.config.api_prefix}/v1/ldap/groups/:cn/members`,
      asyncHandler(async (req, res) => {
        const cn = decodeURIComponent(req.params.cn as string);
        if (!cn) throw new BadRequestError('cn is required');
        const dn = this.routeGroupDn(cn);
        const body = jsonBody(req, res, 'member') as {
          member: string | string[];
        };
        if (!body) return;
        const members = Array.isArray(body.member)
          ? body.member
          : [body.member];
        if (members.some(m => typeof m !== 'string')) {
          throw new BadRequestError('member must be a string or string array');
        }
        await this.judgedGroup(dn, () =>
          this.ldap.authorize('ldapmodifyrequest', [
            dn,
            { add: { member: members } },
            this.opNumber(),
            req,
          ])
        );
        await tryMethod(res, this.addMember.bind(this), cn, body.member, req);
      })
    );

    /**
     * @openapi
     * summary: Remove member from group
     * description: |
     *   `:member` is the URL-encoded DN of the member to remove.
     * responses:
     *   '200':
     *     description: Member removed.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '400':
     *     description: The member is the placeholder (`--group-dummy-user`), which cannot be removed.
     *   '404':
     *     description: Group or member not found.
     *   '409':
     *     description: The member is the last one of the group and no placeholder is configured to take its place.
     */
    // Delete member from group
    app.delete(
      `${this.config.api_prefix}/v1/ldap/groups/:cn/members/:member`,
      asyncHandler(async (req, res) => {
        if (!wantJson(req, res)) return;
        const cn = decodeURIComponent(req.params.cn as string);
        const member = decodeURIComponent(req.params.member as string);
        if (!cn || !member) {
          throw new BadRequestError('cn and member are required');
        }
        const dn = this.routeGroupDn(cn);
        await this.judgedGroup(dn, () =>
          this.ldap.authorize('ldapmodifyrequest', [
            dn,
            { delete: { member: [member] } },
            this.opNumber(),
            req,
          ])
        );
        await tryMethod(res, this.deleteMember.bind(this), cn, member, req);
      })
    );

    // Move group to different organization (only if organization attributes are configured)
    if (
      this.config.ldap_organization_link_attribute &&
      this.config.ldap_organization_path_attribute
    ) {
      /**
       * @openapi
       * summary: Move group to another organization
       * description: |
       *   Only registered when both
       *   `--ldap-organization-link-attribute` and
       *   `--ldap-organization-path-attribute` are configured.
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
       *             description: DN of the destination organization.
       *       example:
       *         targetOrgDn: ou=engineering,ou=organizations,dc=example,dc=com
       * responses:
       *   '200':
       *     description: Group moved.
       *     content:
       *       application/json:
       *         example: { success: true }
       */
      app.post(
        `${this.config.api_prefix}/v1/ldap/groups/:cn/move`,
        asyncHandler(async (req, res) => {
          if (!wantJson(req, res)) return;
          const cn = decodeURIComponent(req.params.cn as string);
          if (!cn) throw new BadRequestError('cn is required');
          const dn = this.routeGroupDn(cn);
          const body = jsonBody(req, res, 'targetOrgDn') as {
            targetOrgDn: string;
          };
          if (!body) return;
          if (typeof body.targetOrgDn !== 'string') {
            throw new BadRequestError('targetOrgDn must be a string');
          }
          const linkAttr = this.config
            .ldap_organization_link_attribute as string;
          await this.judgedGroup(dn, () =>
            this.ldap.authorize('ldapmodifyrequest', [
              dn,
              { replace: { [linkAttr]: body.targetOrgDn } },
              this.opNumber(),
              req,
            ])
          );
          await tryMethod(
            res,
            this.moveGroup.bind(this),
            cn,
            body.targetOrgDn,
            req
          );
        })
      );
    }

    /**
     * @openapi
     * summary: Rename group (change CN)
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         type: object
     *         required: [newCn]
     *         properties:
     *           newCn:
     *             type: string
     *             description: New CN value (RDN attribute).
     *       example:
     *         newCn: site-admins
     * responses:
     *   '200':
     *     description: Group renamed.
     *     content:
     *       application/json:
     *         example: { success: true }
     */
    // Rename group (change cn)
    app.post(
      `${this.config.api_prefix}/v1/ldap/groups/:cn/rename`,
      asyncHandler(async (req, res) => {
        if (!wantJson(req, res)) return;
        const cn = decodeURIComponent(req.params.cn as string);
        if (!cn) throw new BadRequestError('cn is required');
        const dn = this.routeGroupDn(cn);
        const body = jsonBody(req, res, 'newCn') as {
          newCn: string;
        };
        if (!body) return;
        if (typeof body.newCn !== 'string') {
          throw new BadRequestError('newCn must be a string');
        }
        // Renamed into the groups branch, as a group, or not at all
        const newDn = /,/.test(body.newCn)
          ? this.routeGroupDn(body.newCn)
          : this.toGroupDn(body.newCn);
        await this.judgedGroup(dn, () =>
          this.ldap.authorize('ldaprenamerequest', [dn, newDn, req])
        );
        await tryMethod(res, this.renameGroup.bind(this), cn, body.newCn, req);
      })
    );
  }

  /**
   * Whether a member is the placeholder `groupOfNames` needs to stay valid
   * with no real member.
   *
   * Compared as DNs, not as text: the directory answers with its own spelling
   * of a DN, and `uid=fakeUser,ou=users,…` configured must match the
   * `uid=fakeuser, ou=users,…` it may hold.
   *
   * @param member DN of a member
   * @returns true for the placeholder
   */
  isDummyMember(member: string): boolean {
    return isDummyMemberDn(member, this.config.group_dummy_user);
  }

  /**
   * An entry with the placeholder taken out of its members. It is there for
   * the directory's schema, not for anyone reading the group: listed, it
   * reads as a person, and a client editing the list would offer to remove
   * the one member the server refuses to remove.
   *
   * @param entry group as read
   * @returns the same entry, members filtered
   */
  withoutDummyMember<T extends Record<string, unknown>>(entry: T): T {
    const members = entry.member;
    if (members === undefined) return entry;
    const list = Array.isArray(members) ? members : [members];
    return {
      ...entry,
      member: list.filter(m => !this.isDummyMember(m as string)),
    };
  }

  async apiGet(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const cn = decodeURIComponent(req.params.cn as string);
    const dn = this.routeGroupDn(cn);
    try {
      // A group only: another entry named alike is not one
      const result = (await this.ldap.search(
        { paged: false, scope: 'base', filter: this.groupFilter() },
        dn,
        req
      )) as SearchResult;
      if (result.searchEntries.length === 0) {
        throw new NotFoundError('Group not found');
      }
      res.json(
        this.hideNeverReturn(this.withoutDummyMember(result.searchEntries[0]))
      );
    } catch (err) {
      // LDAP NoSuchObjectError (code 32) means not found
      if (
        (err as { code?: number }).code &&
        (err as { code?: number }).code === 32
      ) {
        throw new NotFoundError('Group not found');
      }
      // A DN the directory refuses that the syntax check let through
      if (extractLdapCode(err) === 34)
        throw new BadRequestError(`${cn} is not a valid DN`);
      throw err;
    }
  }

  async apiAdd(
    req: Request,
    res: Response,
    ...requiredFields: string[]
  ): Promise<void> {
    const body = jsonBody(req, res, ...requiredFields) as postAdd | false;
    if (!body) return;
    await this.server.ldap.canonicalAttributes(body as AttributesList);
    assertClientMaySet(this.schema, Object.keys(body), this.cn);
    const cn = body[this.cn];
    // Given as a DN, it is created in the groups branch or not at all
    // A DN as addGroup reads one: a comma, or the groups' main attribute
    if (
      typeof cn === 'string' &&
      (/,/.test(cn) || new RegExp(`^${this.cn}=`, 'i').test(cn))
    )
      this.routeGroupDn(/,/.test(cn) ? cn : `${cn},${this.base as string}`);
    // One member is a list of one, as for any `array`
    const members: string[] = !body.member
      ? []
      : Array.isArray(body.member)
        ? (body.member as string[])
        : [body.member as string];
    // The classes are the plugin's, whatever was sent, as on the flat routes
    const additional: AttributesList = Object.fromEntries(
      Object.entries(body).filter(
        ([key, _value]) =>
          key !== this.cn &&
          key !== 'member' &&
          key !== 'objectClass' &&
          _value !== undefined
      )
    ) as AttributesList;
    await tryMethod(
      res,
      this.addGroup.bind(this),
      cn,
      members,
      additional,
      req
    );
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const cn = decodeURIComponent(req.params.cn as string);
    if (!cn) throw new BadRequestError('cn is required');
    const dn = this.routeGroupDn(cn);
    await this.judgedGroup(dn, () =>
      this.ldap.authorize('ldapdeleterequest', [dn, req])
    );
    await tryMethod(res, this.deleteGroup.bind(this), cn, req);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as postModify | false;
    if (!body) return;
    assertModifyRequest(body);
    const cn = decodeURIComponent(req.params.cn as string);
    if (!cn) throw new BadRequestError('cn is required');
    const dn = this.routeGroupDn(cn);
    await this.server.ldap.canonicalChanges(body);
    assertClientMaySet(
      this.schema,
      modifiedAttributeNames(
        body as Parameters<typeof modifiedAttributeNames>[0]
      )
    );
    await this.judgedGroup(dn, () =>
      this.ldap.authorize('ldapmodifyrequest', [dn, body, this.opNumber(), req])
    );
    await tryMethod(res, this.modifyGroup.bind(this), dn, body, req);
  }

  /**
   * LDAP group methods
   */

  async addGroup(
    cn: string,
    members: string[] = [],
    additional: AttributesList = {},
    req?: Request
  ): Promise<boolean> {
    await this.server.ldap.canonicalAttributes(additional);
    let dn: string;
    const assertedCn = assertedRdnValue(cn, this.cn);
    if (assertedCn !== null) {
      // A bare RDN lies in the groups branch, as a name does
      dn = /,/.test(cn) ? cn : `${cn},${this.base as string}`;
      // The name the DN gives the group
      cn = assertedCn;
      validateDnValue(cn, this.cn);
    } else {
      validateDnValue(cn, this.cn);
      dn = `${this.cn}=${escapeDnValue(cn)},${this.base}`;
    }
    let entry = this.candidateGroup(cn, members, additional);

    // The entry written, judged before the checks reading the directory and
    // before the external members are created: none of it is for a caller
    // who may not create the group. Its default attributes are judged too:
    // one may set the organization link.
    await this.ldap.authorize('ldapaddrequest', [dn, { ...entry }, req]);
    await this.validateMembers(dn, members, req);
    const candidate = await this.validateNewGroup(dn, {
      objectClass: entry.objectClass,
      [this.cn]: cn,
      member: members,
      ...additional,
    });
    // The entry holds the placeholder member too; what else was validated
    // is written in the shape it was given, over the entry judged, and the
    // defaults `candidateGroup` added on top are converted here
    delete candidate.member;
    Object.assign(entry, candidate);
    toDirectoryEntry(this.schema, entry);
    [dn, entry] = await launchHooksChained(this.registeredHooks.ldapgroupadd, [
      dn,
      entry,
    ]);
    let res;
    try {
      res = await this.ldap.add(dn, entry, req);
    } catch (err) {
      // A rule that refused the write chose its own status: wrapping it in a
      // plain Error turned a 409 into a 500. The schema now carries `unique`
      // and `mailDomainScope`, so this is the ordinary path, not the rare one.
      if (err instanceof HttpError) throw err;
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to add group ${dn}: ${err}`);
    }
    void launchHooks(this.registeredHooks.ldapgroupadddone, [dn, entry]);
    return res;
  }

  /**
   * The entry `addGroup` writes, as the plugin's own hooks receive it. Built
   * in one place, so that a creation judged before it is made — here, or by
   * a plugin checking something first — is the creation made.
   *
   * @param cn the group's cn
   * @param members member DNs
   * @param additional attributes sent
   * @returns the entry
   */
  candidateGroup(
    cn: string,
    members: string[],
    additional: AttributesList
  ): AttributesList {
    // Build entry
    const objectClasses = [...(this.config.group_class as string[])];

    // Add twakeGroup objectClass if group has mail or twake-specific attributes
    // Only add if not already using twakeStaticGroup (which includes all these attributes)
    if (
      (additional.mail ||
        additional.twakeMailboxType ||
        additional.twakeDepartmentLink ||
        additional.twakeDepartmentPath) &&
      !objectClasses.includes('twakeGroup') &&
      !objectClasses.includes('twakeStaticGroup')
    ) {
      objectClasses.push('twakeGroup');
    }

    const entry: AttributesList = {
      // Classes from --group-class (with twakeGroup added if mail present)
      objectClass: objectClasses,
      // Default attributes from --group-default-attributes
      ...this.config.group_default_attributes,
      // cn calculated here
      [this.cn]: cn,
      // members with at least one fake member to satisfy LDAP groupOfNames schema
      member: [this.config.group_dummy_user as string],
      ...additional,
    };
    if (members.length) (entry.member as string[]).push(...members);
    applyFixedDefaults(this.schema, entry);
    return entry;
  }

  async modifyGroup(
    cn: string,
    changes: {
      add?: AttributesList;
      replace?: AttributesList;
      delete?: string[] | AttributesList;
    },
    req?: Request
  ): Promise<boolean> {
    // `MEMBER` is `member`: the guards below compare names as the write
    // gives them
    await this.server.ldap.canonicalChanges(changes);
    let dn = this.toGroupDn(cn);
    const op = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.registeredHooks.ldapgroupmodify,
      [dn, changes, op]
    );
    if (changes.add) {
      if (changes.add.member)
        throw new BadRequestError('Use dedicated API to add members');
      if (changes.add[this.cn])
        throw new BadRequestError(`${this.cn} attribute is unique, cannot add`);
    }
    if (changes.delete) {
      if (changes.delete instanceof Object) {
        if ((changes.delete as AttributesList).member)
          throw new BadRequestError('Use dedicated API to delete members');
        if ((changes.delete as AttributesList)[this.cn])
          throw new BadRequestError(`Cannot delete ${this.cn} attribute`);
      }
      if (Array.isArray(changes.delete)) {
        if (changes.delete.includes('member'))
          throw new BadRequestError('Use dedicated API to delete members');
        if (changes.delete.includes(this.cn))
          throw new BadRequestError(`Cannot delete ${this.cn} attribute`);
      }
    }
    if (changes.replace) {
      if (changes.replace.member)
        throw new BadRequestError('Use dedicated API to replace members');
      if (changes.replace[this.cn])
        throw new BadRequestError(
          `Use dedicated API to change ${this.cn} attribute`
        );
    }

    // Before the checks reading the directory, as on a creation
    await this.ldap.authorize('ldapmodifyrequest', [dn, changes, op, req]);
    changes = await this.validateChanges(dn, changes);
    const res = await this.ldap.modify(dn, changes, req);
    void launchHooks(this.registeredHooks.ldapgroupmodifydone, [
      dn,
      changes,
      op,
    ]);
    return res;
  }

  async renameGroup(
    cn: string,
    newCn: string,
    req?: Request
  ): Promise<boolean> {
    if (!/,/.test(cn)) {
      validateDnValue(cn, this.cn);
    }
    if (!/,/.test(newCn)) {
      validateDnValue(newCn, this.cn);
    }
    let dn = this.toGroupDn(cn);
    let newDn = this.toGroupDn(newCn);
    [dn, newDn] = await launchHooksChained(
      this.registeredHooks.ldapgrouprename,
      [dn, newDn]
    );
    const res = await this.ldap.rename(dn, newDn, req);
    void launchHooks(this.registeredHooks.ldapgrouprenamedone, [dn, newDn]);
    return res;
  }

  async deleteGroup(cn: string, req?: Request): Promise<boolean> {
    let dn = this.toGroupDn(cn);
    dn = await launchHooksChained(this.registeredHooks.ldapgroupdelete, dn);
    const res = await this.ldap.delete(dn, req);
    void launchHooks(this.registeredHooks.ldapgroupdeletedone, dn);
    return res;
  }

  /**
   * Add members to a group.
   *
   * With `req`, the change is judged as a modification of the group, and
   * each member must be an entry the caller can read: the routes used to
   * call this without it, which every authorization plugin reads as an
   * internal call and lets through — anyone authenticated could join any
   * group, a team mailbox included (#325).
   *
   * @param cn group cn or DN
   * @param member member DN(s)
   * @param req the request, to authorize the change against its caller
   */
  async addMember(
    cn: string,
    member: string | string[],
    req?: Request
  ): Promise<boolean> {
    const dn = this.toGroupDn(cn);
    if (!Array.isArray(member)) member = [member];
    [cn, member] = await launchHooksChained(
      this.registeredHooks.ldapgroupaddmember,
      [cn, member]
    );
    // Before the members are looked for, and the external ones created
    await this.ldap.authorize('ldapmodifyrequest', [
      dn,
      { add: { member } },
      this.opNumber(),
      req,
    ]);
    await this.validateMembers(dn, member, req);
    return await this.ldap
      .modify(
        dn,
        {
          add: { member },
        },
        req
      )
      .catch(err => {
        if (err instanceof HttpError) throw err;
        throw new Error(`Failed to add member(s) to ${dn}: ${err}`);
      });
  }

  /**
   * Remove a member from a group; with `req`, judged as a modification of
   * the group, as {@link addMember} is.
   *
   * @param cn group cn or DN
   * @param member member DN
   * @param req the request, to authorize the change against its caller
   */
  async deleteMember(
    cn: string,
    member: string,
    req?: Request
  ): Promise<boolean> {
    const dn = this.toGroupDn(cn);
    [cn, member] = await launchHooksChained(
      this.registeredHooks.ldapgroupdeletemember,
      [cn, member]
    );
    // Refusing the placeholder is an answer to the client, not a fault:
    // a plain Error made it a 500.
    if (this.isDummyMember(member))
      throw new BadRequestError('Cannot delete dummy member from group');
    return await this.removeMember(dn, member, req).catch(err => {
      if (extractLdapCode(err) === 16)
        throw new NotFoundError(`${member} is not a member of ${dn}`);
      if (err instanceof HttpError) throw err;
      throw new Error(`Failed to delete member ${member} from ${dn}: ${err}`);
    });
  }

  /**
   * Take a member out of a group. The last member of a `groupOfNames` cannot
   * simply go — the schema wants one (objectClassViolation): the placeholder
   * takes its place in the same change, as it does in a group created empty.
   * With no placeholder configured, the group cannot be left empty, which is
   * the caller's to resolve, not a fault of the server.
   *
   * @param dn group DN
   * @param member member DN
   * @param req the request, to authorize the change against its caller
   */
  private async removeMember(
    dn: string,
    member: string,
    req?: Request
  ): Promise<boolean> {
    return await this.ldap
      .modify(dn, { delete: { member } }, req)
      .catch(err => {
        if (extractLdapCode(err) !== 65) throw err;
        const placeholder = this.config.group_dummy_user;
        if (!placeholder)
          throw new ConflictError(
            `Cannot remove ${member}, the last member of ${dn}: a group needs at least one member`
          );
        return this.ldap.modify(
          dn,
          { add: { member: placeholder }, delete: { member } },
          req
        );
      });
  }

  async deleteMemberFromAll(memberDn: string): Promise<void> {
    // As the server: a deleted entry leaves every group, whoever deleted it
    const res = (await this.ldap.system
      .search(
        {
          filter: `member=${escapeLdapFilter(memberDn)}`,
          paged: false,
          attributes: [this.cn],
        },
        this.base as string
      )
      .catch(err => {
        throw new Error(`Failed to search groups from ${this.base}: ${err}`);
      })) as SearchResult;

    await Promise.all(
      res.searchEntries.map(entry =>
        this.removeMember(entry.dn, memberDn).catch(err => {
          // A directory running the refint overlay removes the member on
          // its own, after the delete has answered; a group deleted in the
          // meantime has no member left to remove either.
          const code = extractLdapCode(err);
          if (code === 16 || code === 32) return;
          this.logger.error(
            `Failed to remove ${memberDn} from group ${entry.dn}:`,
            err
          );
        })
      )
    );
  }

  /**
   * Move a group to a different organization by updating organization link and path attributes
   * This method should only be called when organization attributes are configured
   * @param cn Group cn or DN
   * @param targetOrgDn DN of the target organization
   * @returns Success status
   */
  async moveGroup(
    cn: string,
    targetOrgDn: string,
    req?: Request
  ): Promise<{ success: boolean }> {
    const linkAttr = this.config.ldap_organization_link_attribute as string;
    const pathAttr = this.config.ldap_organization_path_attribute as string;
    const dn = this.toGroupDn(cn);

    // Judged before the group and the target are read, as the server: which
    // organization holds a group, and whether either is there, are not for
    // a caller who may not move it there
    await this.ldap.authorize('ldapmodifyrequest', [
      dn,
      { replace: { [linkAttr]: targetOrgDn } },
      this.opNumber(),
      req,
    ]);

    // Get current group to check if it has department attributes
    let currentGroup: SearchResult;
    try {
      // As the server: the move was judged first (authorize), this only shapes the answer
      currentGroup = (await this.ldap.system.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
    } catch (err) {
      // A base search of a DN that is not there fails with noSuchObject
      if (extractLdapCode(err) === 32)
        throw new NotFoundError(`Group ${dn} not found`);
      throw err;
    }

    if (currentGroup.searchEntries.length === 0) {
      throw new NotFoundError(`Group ${dn} not found`);
    }

    const group = currentGroup.searchEntries[0];
    const currentDeptLink = organizationLink(group[linkAttr]);

    // Check if group has department link attribute
    if (!currentDeptLink) {
      throw new BadRequestError(
        `Group ${dn} does not have ${linkAttr} attribute and cannot be moved`
      );
    }

    // Prevent moving to the same location
    if (currentDeptLink === targetOrgDn) {
      throw new BadRequestError('Group is already in the target organization');
    }

    // Verify target organization exists and get its path
    let targetOrg: SearchResult;
    try {
      // As the server: the move was judged first (authorize), this only shapes the answer
      targetOrg = (await this.ldap.system.search(
        {
          paged: false,
          scope: 'base',
          attributes: [pathAttr, 'ou', 'o'],
        },
        targetOrgDn
      )) as SearchResult;
    } catch (err) {
      const code = extractLdapCode(err);
      if (code === 32)
        throw new NotFoundError(`Target organization ${targetOrgDn} not found`);
      if (code === 34)
        throw new BadRequestError(`${targetOrgDn} is not a valid DN`);
      throw new Error(
        `Target organization ${targetOrgDn} not found: ${err instanceof Error && err.message ? err.message : String(err)}`
      );
    }

    if (targetOrg.searchEntries.length === 0) {
      throw new NotFoundError(`Target organization ${targetOrgDn} not found`);
    }

    const targetPath = targetOrg.searchEntries[0][pathAttr] as
      | string
      | undefined;

    if (!targetPath) {
      throw new Error(
        `Target organization ${targetOrgDn} does not have ${pathAttr} attribute`
      );
    }

    // Update group's department link and path
    await this.ldap.modify(
      dn,
      {
        replace: {
          [linkAttr]: targetOrgDn,
          [pathAttr]: targetPath,
        },
      },
      req
    );

    this.logger.info(
      `Group ${dn} moved from ${currentDeptLink} to ${targetOrgDn}`
    );

    return { success: true };
  }

  /**
   * List groups from LDAP
   * @param param0 {filter, attributes, req}:
   * - filter: LDAP filter (default '(objectClass=*)')
   * - attributes: attributes to fetch (default ['cn','member'])
   * - req: incoming request, forwarded to the authorization hooks
   * @returns LdapList (Record<string, AttributesList>)
   */
  async listGroups({
    filter,
    attributes,
    req,
  }: {
    filter?: string;
    attributes?: string[];
    req?: Request;
  } = {}): Promise<LdapList> {
    const _res: AsyncGenerator<SearchResult> = (await this.ldap
      .search(
        {
          filter: filter || '(objectClass=*)',
          attributes: attributes || [this.cn, 'member'],
          paged: true,
        },
        this.base as string,
        req
      )
      .catch(err => {
        throw new Error(`Failed to list groups from ${this.base}: ${err}`);
      })) as AsyncGenerator<SearchResult>;
    let entries: LdapList = {};
    for await (const r of _res) {
      for (const entry of r.searchEntries) {
        // An entry under the group base holding no main attribute is not a
        // group but something keeping them — an `ou=` container, typically.
        // The search asked for that attribute, so the client answers with an
        // empty array rather than with nothing, and an array is truthy: `!s`
        // let the container through and keyed the listing on `''`, which a
        // console shows as a row with no name.
        const raw = entry[this.cn];
        if (Array.isArray(raw) && raw.length === 0) continue;
        const s = raw as string;
        if (!s) continue;
        // `member` is absent when the caller did not ask for it: wrapping
        // `undefined` in an array made those listings read `"member":[null]`.
        entries[s] = this.withoutDummyMember(entry);
      }
    }

    entries = await launchHooksChained(
      this.registeredHooks._ldapgrouplist,
      entries
    );
    return entries;
  }

  /**
   * Simple formatter for listGroups()
   * @param cn main attribute value (partial or full)
   * @param partial boolean, true for partial search (default false)
   * @param attributes array of attributes to return
   * @param req incoming request, forwarded to the authorization hooks
   * @returns LdapList (means Record<string, AttributesList> where key is the --ldap-user-main-attribute value [default: cn])
   */
  async searchGroupsByName(
    cn: string,
    partial = false,
    attributes: string[] = [this.cn, 'member'],
    req?: Request
  ): Promise<LdapList> {
    const value = escapeLdapFilter(cn);
    const filter = partial
      ? `(${this.cn}=*${value}*)`
      : `(${this.cn}=${value})`;
    return await this.listGroups({ filter, attributes, req });
  }

  /**
   * The DN of a group named by its `cn`, or given as a DN: one with a comma.
   * A DN the directory would refuse is answered 400 rather than its error.
   *
   * @param cn the group's name, or its DN
   * @returns its DN
   */
  protected toGroupDn(cn: string): string {
    if (!/,/.test(cn)) return `${this.cn}=${escapeDnValue(cn)},${this.base}`;
    if (!isDnSyntax(cn)) throw new BadRequestError(`${cn} is not a valid DN`);
    return cn;
  }

  /**
   * {@link toGroupDn} for a route serving the groups branch: what is not
   * below it, nor named as these groups are (`cn=`), is no group of these
   * routes, whatever entry it is (#395). The branch may be the whole
   * directory, which is the default: the naming is what tells an account
   * from a group there. A multi-valued RDN holding the main attribute
   * passes here; the group class, checked next, is what settles it.
   *
   * @param cn the group's name, or its DN
   * @returns its DN
   */
  protected routeGroupDn(cn: string): string {
    const dn = this.toGroupDn(cn);
    const base = this.base as string;
    const type = normalizeDn(`${this.cn}=x`).split('=')[0];
    if (
      !isDnInBranch(dn, base) ||
      normalizeDn(dn) === normalizeDn(base) ||
      // Any assertion of the RDN, the unescaped `+` apart
      !normalizeDn(getRdn(dn))
        .split(/(?<!\\)\+/)
        .some(assertion => assertion.startsWith(`${type}=`))
    )
      throw new NotFoundError('Group not found');
    return dn;
  }

  /**
   * A filter matching a group: one of the classes this plugin gives groups
   * (`--group-class`), or a standard group class.
   */
  private groupFilter(): string {
    const classes = new Set(
      [
        ...(this.config.group_class ?? []),
        'groupOfNames',
        'groupOfUniqueNames',
        'groupOfURLs',
        'posixGroup',
      ].filter(name => name && name.toLowerCase() !== 'top')
    );
    return `(|${[...classes].map(name => `(objectClass=${escapeLdapFilter(name)})`).join('')})`;
  }

  /**
   * That the entry a route writes is a group, once the write is judged:
   * another entry named alike is not one, and is not written as one (#395).
   *
   * Judged first, a caller who may not make the write gets the refusal
   * whether the entry is there, a group or not; only one who may learns
   * that it is none.
   *
   * @param dn the entry, from {@link routeGroupDn}
   * @param judge the authorization of the write, as `ldap.authorize`
   */
  protected async judgedGroup(
    dn: string,
    judge: () => Promise<void>
  ): Promise<void> {
    await judge();
    let found: SearchResult;
    try {
      // As the server: the write was judged, this only shapes the answer
      found = (await this.ldap.system.search(
        {
          paged: false,
          scope: 'base',
          filter: this.groupFilter(),
          attributes: ['1.1'],
        },
        dn
      )) as SearchResult;
    } catch (err) {
      const code = extractLdapCode(err);
      if (code === 32) throw new NotFoundError('Group not found');
      if (code === 34) throw new BadRequestError(`${dn} is not a valid DN`);
      throw err;
    }
    if (!found.searchEntries?.length)
      throw new NotFoundError('Group not found');
  }

  /**
   * Verify that each member exists in LDAP
   *
   * It calls ldapgroupvalidatemembers hook before validation
   * so that plugins can modify the members list and/or the group DN
   * and/or create missing members on the fly
   *
   * With `req`, each member is looked up as the caller sees the directory:
   * an entry an authorization plugin hides from them is refused as one that
   * does not exist, so that an administrator cannot put an account of
   * another branch in a group of theirs. `--group-allow-unexistent-members`
   * still accepts a member that does not exist, but not one that does and
   * is hidden — which tells the caller it exists, a smaller leak than the
   * membership it would otherwise grant.
   *
   * @param dn Group DN (given to hooks)
   * @param members Array of member DNs to check
   * @param req the request, whose caller must be able to read each member
   * @returns nothing, throw if error
   */
  async validateMembers(
    dn: string,
    members: string[],
    req?: Request
  ): Promise<void> {
    [dn, members] = await launchHooksChained(
      this.server.hooks.ldapgroupvalidatemembers,
      [dn, members]
    );
    const allowMissing = Boolean(this.config.groups_allow_unexistent_members);
    if (allowMissing && !req) return;
    if (!members || !members.length) return;
    try {
      // Parallelize member validation with global concurrency limit
      await Promise.all(
        members.map(m =>
          this.server.ldap.queryLimit(async () => {
            let found: SearchResult;
            try {
              found = (await this.ldap.search(
                { paged: false, scope: 'base' },
                m,
                req
              )) as SearchResult;
            } catch (e) {
              if (isAuthzRefusal(e)) throw e;
              if (allowMissing) return;
              const code = extractLdapCode(e);
              if (code === 32)
                throw new BadRequestError(`Member ${m} not found`);
              if (code === 34)
                throw new BadRequestError(`Member ${m} is not a valid DN`);
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new Error(`Member ${m} not found: ${e}`);
            }
            // Filtered out by an authorization plugin: there, but not for
            // this caller. Only asked of a caller's request, so that an
            // internal call keeps accepting what it always accepted.
            if (req && !found.searchEntries?.length)
              throw new BadRequestError(`Member ${m} not found`);
          })
        )
      );
    } catch (err) {
      if (err instanceof HttpError || isAuthzRefusal(err)) throw err;
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to find member(s): ${err}`);
    }
  }

  /**
   * Check a new group's entry, after the `ldapgroupvalidatenew` hooks, and
   * convert it in place.
   *
   * @returns the entry the hooks handed on; `addGroup` writes its
   *   attributes over the entry it judged, the members aside
   */
  async validateNewGroup(
    dn: string,
    entry: AttributesList
  ): Promise<AttributesList> {
    [dn, entry] = await launchHooksChained(
      this.server.hooks.ldapgroupvalidatenew,
      [dn, entry]
    );
    await this.validator().validateNew(entry);
    return entry;
  }

  /**
   * Check a change, after the `ldapgroupvalidatechanges` hooks, and convert
   * it in place.
   *
   * @returns the change the hooks handed on
   */
  async validateChanges(
    dn: string,
    changes: ModifyRequest
  ): Promise<ModifyRequest> {
    [dn, changes] = await launchHooksChained(
      this.server.hooks.ldapgroupvalidatechanges,
      [dn, changes]
    );
    await this.validator().validateChanges(changes);
    return changes;
  }

  /** The schema's rules; the pointer lookups run as the server */
  validator(): EntityValidator {
    return new EntityValidator(this.schema, {
      entryExists: async (dn): Promise<boolean> => {
        try {
          const result = (await this.ldap.system.search(
            { paged: false, scope: 'base', attributes: ['dn'] },
            dn
          )) as SearchResult;
          return result.searchEntries.length > 0;
        } catch {
          return false;
        }
      },
      loadedPlugins: this.server.loadedPlugins,
      singularName: 'group',
    });
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const apiPrefix = this.config.api_prefix || '/api';

    // Where a static plugin serves the file, whatever its name
    const schemaUrl = this.config.group_schema
      ? staticSchemaUrl(this.server, this.config.group_schema)
      : undefined;

    return {
      enabled: true,
      base: this.base || '',
      mainAttribute: this.cn || 'cn',
      objectClass: this.config.group_class || ['top', 'groupOfNames'],
      schema: this.schema,
      schemaUrl,
      endpoints: {
        list: `${apiPrefix}/v1/ldap/groups`,
        get: `${apiPrefix}/v1/ldap/groups/:id`,
        create: `${apiPrefix}/v1/ldap/groups`,
        update: `${apiPrefix}/v1/ldap/groups/:id`,
        delete: `${apiPrefix}/v1/ldap/groups/:id`,
        addMember: `${apiPrefix}/v1/ldap/groups/:id/members`,
        removeMember: `${apiPrefix}/v1/ldap/groups/:id/members/:memberId`,
        rename: `${apiPrefix}/v1/ldap/groups/:id/rename`,
        move: `${apiPrefix}/v1/ldap/groups/:id/move`,
      },
    };
  }
}
