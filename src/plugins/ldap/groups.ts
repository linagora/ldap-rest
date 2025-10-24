/**
 * @module plugins/ldap/groups
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Plugin to manage groups into LDAP server
 * - add/delete groups
 * - add/delete members of groups
 * - detect user deletion to remove them from groups (hook)
 */
import fs from 'fs';

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
import {
  badRequest,
  jsonBody,
  notFound,
  ok,
  serverError,
  tryMethod,
  wantJson,
} from '../../lib/expressFormatedResponses';
import {
  launchHooks,
  launchHooksChained,
  transformSchemas,
} from '../../lib/utils';
import type { Schema } from '../../config/schema';

export interface postAdd {
  cn?: string;
  [key: string]: AttributeValue | undefined;
}
export type postModify = ModifyRequest;

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
    if (this.config.group_schema) {
      fs.readFile(this.config.group_schema, (err, data) => {
        if (err) {
          this.logger.error(
            // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions
            `Failed to load group schema from ${this.config.group_schema}: ${err}`
          );
        } else {
          try {
            this.schema = JSON.parse(
              transformSchemas(data.toString(), this.config)
            ) as Schema;
            this.logger.debug('Group schema loaded');
          } catch (e) {
            this.logger.error(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Failed to parse ${this.config.schemas_path}/group.json: ${e}`
            );
          }
        }
      });
    }
  }

  /**
   * Catch all deletion to remove deleted users from groups
   */
  hooks: Hooks = {
    ldapdeleterequest: async dn => {
      let _dn = dn;
      if (!Array.isArray(_dn)) {
        _dn = [_dn];
      }
      this.logger.debug(
        `User deletion detected, removing from groups: ${_dn.join(', ')}`
      );
      // Remove user from groups before actual deletion
      await Promise.all(
        _dn.map(dnEntry => this.deleteMemberFromAll(dnEntry))
      ).catch(err => {
        this.logger.error('Failed to process user deletion in groups:', err);
      });
      return dn;
    },
  };

  /**
   * API routes
   */

  api(app: Express): void {
    // List groups
    app.get(`${this.config.api_prefix}/v1/ldap/groups`, async (req, res) => {
      if (!wantJson(req, res)) return;
      try {
        const args: { filter?: string; attributes?: string[] } = {};
        if (
          req.query.match &&
          (typeof req.query.match !== 'string' ||
            !/^[\w*=()&|]+$/.test(req.query.match))
        )
          return badRequest(res, 'Invalid match query');
        if (req.query.match)
          args.filter = /=/.test(req.query.match)
            ? `${req.query.match}`
            : `(${this.cn}=${req.query.match})`;
        if (req.query.attributes && typeof req.query.attributes === 'string')
          args.attributes = req.query.attributes.split(',');
        const list = await this.listGroups(args);
        return ok(res, list);
      } catch (err) {
        return serverError(res, err);
      }
    });

    // Get group by cn or DN
    app.get(`${this.config.api_prefix}/v1/ldap/groups/:cn`, async (req, res) =>
      this.apiGet(req, res)
    );

    // Add group
    app.post(`${this.config.api_prefix}/v1/ldap/groups`, async (req, res) =>
      this.apiAdd(req, res, this.cn)
    );

    // Delete group
    app.delete(
      `${this.config.api_prefix}/v1/ldap/groups/:cn`,
      async (req, res) => this.apiDelete(req, res)
    );

    // Modify group
    app.put(`${this.config.api_prefix}/v1/ldap/groups/:cn`, async (req, res) =>
      this.apiModify(req, res)
    );

    // Add member to group
    app.post(
      `${this.config.api_prefix}/v1/ldap/groups/:cn/members`,
      async (req, res) => {
        const cn = decodeURIComponent(req.params.cn);
        if (!cn) return badRequest(res, 'cn is required');
        const body = jsonBody(req, res, 'member') as {
          member: string | string[];
        };
        if (!body) return;
        await tryMethod(res, this.addMember.bind(this), cn, body.member);
      }
    );

    // Delete member from group
    app.delete(
      `${this.config.api_prefix}/v1/ldap/groups/:cn/members/:member`,
      async (req, res) => {
        if (!wantJson(req, res)) return;
        const cn = decodeURIComponent(req.params.cn);
        const member = decodeURIComponent(req.params.member);
        if (!cn || !member) {
          return badRequest(res, 'cn and member are required');
        }
        await tryMethod(res, this.deleteMember.bind(this), cn, member);
      }
    );

    // Move group to different organization (only if organization attributes are configured)
    if (
      this.config.ldap_organization_link_attribute &&
      this.config.ldap_organization_path_attribute
    ) {
      app.post(
        `${this.config.api_prefix}/v1/ldap/groups/:cn/move`,
        async (req, res) => {
          if (!wantJson(req, res)) return;
          const cn = decodeURIComponent(req.params.cn);
          if (!cn) return badRequest(res, 'cn is required');
          const body = jsonBody(req, res, 'targetOrgDn') as {
            targetOrgDn: string;
          };
          if (!body) return;
          await tryMethod(
            res,
            this.moveGroup.bind(this),
            cn,
            body.targetOrgDn,
            req
          );
        }
      );
    }

    // Rename group (change cn)
    app.post(
      `${this.config.api_prefix}/v1/ldap/groups/:cn/rename`,
      async (req, res) => {
        if (!wantJson(req, res)) return;
        const cn = decodeURIComponent(req.params.cn);
        if (!cn) return badRequest(res, 'cn is required');
        const body = jsonBody(req, res, 'newCn') as {
          newCn: string;
        };
        if (!body) return;
        await tryMethod(res, this.renameGroup.bind(this), cn, body.newCn);
      }
    );
  }

  async apiGet(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const cn = decodeURIComponent(req.params.cn);
    try {
      const dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;
      const result = (await this.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
      if (result.searchEntries.length === 0) {
        return notFound(res, 'Group not found');
      }
      res.json(result.searchEntries[0]);
    } catch (err) {
      // LDAP NoSuchObjectError (code 32) means not found
      if (
        (err as { code?: number }).code &&
        (err as { code?: number }).code === 32
      ) {
        return notFound(res, 'Group not found');
      }
      return serverError(res, err);
    }
  }

  async apiAdd(
    req: Request,
    res: Response,
    ...requiredFields: string[]
  ): Promise<void> {
    const body = jsonBody(req, res, ...requiredFields) as postAdd | false;
    if (!body) return;
    const cn = body[this.cn];
    const members = body.member ? body.member : [];
    const additional: AttributesList = Object.fromEntries(
      Object.entries(body).filter(
        ([key, _value]) =>
          key !== this.cn &&
          key !== 'member' &&
          _value !== undefined &&
          // Filter out fixed fields from schema
          !(this.schema?.attributes[key]?.fixed === true)
      )
    ) as AttributesList;
    await tryMethod(res, this.addGroup.bind(this), cn, members, additional);
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const cn = decodeURIComponent(req.params.cn);
    if (!cn) return badRequest(res, 'cn is required');
    await tryMethod(res, this.deleteGroup.bind(this), cn);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as postModify | false;
    if (!body) return;
    const dn = this.fixDn(decodeURIComponent(req.params.cn));
    if (!dn) return badRequest(res);
    // Filter out fixed fields from schema
    const filteredBody = Object.fromEntries(
      Object.entries(body).filter(
        ([key, _value]) => !(this.schema?.attributes[key]?.fixed === true)
      )
    ) as postModify;
    await tryMethod(res, this.modifyGroup.bind(this), dn, filteredBody);
  }

  /**
   * LDAP group methods
   */

  async addGroup(
    cn: string,
    members: string[] = [],
    additional: AttributesList = {}
  ): Promise<boolean> {
    let dn: string;
    if (new RegExp(`^${this.cn}=`).test(cn)) {
      dn = cn;
      cn = cn.replace(new RegExp(`^${this.cn}=([^,]+).*`), '$1');
    } else {
      dn = `${this.cn}=${cn},${this.base}`;
    }
    await this.validateMembers(dn, members);
    await this.validateNewGroup(dn, {
      objectClass: this.config.group_class as string[],
      cn,
      member: members,
      ...additional,
    });

    // Build entry
    let objectClasses = [...(this.config.group_class as string[])];

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

    let entry: AttributesList = {
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
    [dn, entry] = await launchHooksChained(this.registeredHooks.ldapgroupadd, [
      dn,
      entry,
    ]);
    let res;
    try {
      res = await this.ldap.add(dn, entry);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to add group ${dn}: ${err}`);
    }
    void launchHooks(this.registeredHooks.ldapgroupadddone, [dn, entry]);
    return res;
  }

  async modifyGroup(
    cn: string,
    changes: {
      add?: AttributesList;
      replace?: AttributesList;
      delete?: string[] | AttributesList;
    }
  ): Promise<boolean> {
    let dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;
    const op = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.registeredHooks.ldapgroupmodify,
      [dn, changes, op]
    );
    if (changes.add) {
      if (changes.add.member)
        throw new Error('Use dedicated API to add members');
      if (changes.add[this.cn])
        throw new Error(`${this.cn} attribute iq unique, cannot add`);
    }
    if (changes.delete) {
      if (changes.delete instanceof Object) {
        if ((changes.delete as AttributesList).member)
          throw new Error('Use dedicated API to delete members');
        if ((changes.delete as AttributesList)[this.cn])
          throw new Error(`Cannot delete ${this.cn} attribute`);
      }
      if (Array.isArray(changes.delete)) {
        if (changes.delete.includes('member'))
          throw new Error('Use dedicated API to delete members');
        if (changes.delete.includes(this.cn))
          throw new Error(`Cannot delete ${this.cn} attribute`);
      }
    }
    if (changes.replace) {
      if (changes.replace.member)
        throw new Error('Use dedicated API to replace members');
      if (changes.replace[this.cn])
        throw new Error(`Use dedicated API to change ${this.cn} attribute`);
    }

    await this.validateChanges(dn, changes);
    const res = await this.ldap.modify(dn, changes);
    void launchHooks(this.registeredHooks.ldapgroupmodifydone, [
      dn,
      changes,
      op,
    ]);
    return res;
  }

  async renameGroup(cn: string, newCn: string): Promise<boolean> {
    let dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;
    let newDn = /,/.test(newCn) ? newCn : `${this.cn}=${newCn},${this.base}`;
    [dn, newDn] = await launchHooksChained(
      this.registeredHooks.ldapgrouprename,
      [dn, newDn]
    );
    const res = await this.ldap.rename(dn, newDn);
    void launchHooks(this.registeredHooks.ldapgrouprenamedone, [dn, newDn]);
    return res;
  }

  async deleteGroup(cn: string): Promise<boolean> {
    let dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;
    dn = await launchHooksChained(this.registeredHooks.ldapgroupdelete, dn);
    const res = await this.ldap.delete(dn);
    void launchHooks(this.registeredHooks.ldapgroupdeletedone, dn);
    return res;
  }

  async addMember(cn: string, member: string | string[]): Promise<boolean> {
    const dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;
    if (!Array.isArray(member)) member = [member];
    [cn, member] = await launchHooksChained(
      this.registeredHooks.ldapgroupaddmember,
      [cn, member]
    );
    await this.validateMembers(dn, member);
    return await this.ldap
      .modify(dn, {
        add: { member },
      })
      .catch(err => {
        throw new Error(`Failed to add member(s) to ${dn}: ${err}`);
      });
  }

  async deleteMember(cn: string, member: string): Promise<boolean> {
    const dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;
    [cn, member] = await launchHooksChained(
      this.registeredHooks.ldapgroupdeletemember,
      [cn, member]
    );
    if (member === this.config.group_dummy_user)
      throw new Error('Cannot delete dummy member from group');
    return await this.ldap
      .modify(dn, {
        delete: { member: member },
      })
      .catch(err => {
        throw new Error(`Failed to delete member ${member} from ${dn}: ${err}`);
      });
  }

  async deleteMemberFromAll(memberDn: string): Promise<void> {
    const res = (await this.ldap
      .search(
        {
          filter: `member=${memberDn}`,
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
        this.ldap
          .modify(entry.dn, {
            delete: { member: memberDn },
          })
          .catch(err =>
            this.logger.error(
              `Failed to remove ${memberDn} from group ${entry.dn}:`,
              err
            )
          )
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
    const dn = /,/.test(cn) ? cn : `${this.cn}=${cn},${this.base}`;

    // Get current group to check if it has department attributes
    const currentGroup = (await this.ldap.search(
      { paged: false, scope: 'base' },
      dn
    )) as SearchResult;

    if (currentGroup.searchEntries.length === 0) {
      throw new Error(`Group ${dn} not found`);
    }

    const group = currentGroup.searchEntries[0];
    const currentDeptLink = group[linkAttr] as string | undefined;

    // Check if group has department link attribute
    if (!currentDeptLink) {
      throw new Error(
        `Group ${dn} does not have ${linkAttr} attribute and cannot be moved`
      );
    }

    // Prevent moving to the same location
    if (currentDeptLink === targetOrgDn) {
      throw new Error('Group is already in the target organization');
    }

    // Verify target organization exists and get its path
    let targetOrg: SearchResult;
    try {
      targetOrg = (await this.ldap.search(
        {
          paged: false,
          scope: 'base',
          attributes: [pathAttr, 'ou', 'o'],
        },
        targetOrgDn
      )) as SearchResult;
    } catch (err) {
      throw new Error(
        `Target organization ${targetOrgDn} not found: ${err instanceof Error && err.message ? err.message : String(err)}`
      );
    }

    if (targetOrg.searchEntries.length === 0) {
      throw new Error(`Target organization ${targetOrgDn} not found`);
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
   * @param param0 {filter, attributes}:
   * - filter: LDAP filter (default '(objectClass=*)')
   * - attributes: attributes to fetch (default ['cn','member'])
   * @returns LdapList (Record<string, AttributesList>)
   */
  async listGroups({
    filter,
    attributes,
  }: {
    filter?: string;
    attributes?: string[];
  } = {}): Promise<LdapList> {
    const _res: AsyncGenerator<SearchResult> = (await this.ldap
      .search(
        {
          filter: filter || '(objectClass=*)',
          attributes: attributes || [this.cn, 'member'],
          paged: true,
        },
        this.base as string
      )
      .catch(err => {
        throw new Error(`Failed to list groups from ${this.base}: ${err}`);
      })) as AsyncGenerator<SearchResult>;
    let entries: LdapList = {};
    for await (const r of _res) {
      r.searchEntries.map(entry => {
        const s = entry[this.cn] as string;
        if (s) entries[s] = entry;
        if (!Array.isArray(entries[s].member))
          entries[s].member = [entries[s].member as string];
        entries[s].member = (entries[s].member as string[]).filter(
          (m: string) => {
            return m !== this.config.group_dummy_user;
          }
        );
      });
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
   * @returns LdapList (means Record<string, AttributesList> where key is the --ldap-user-main-attribute value [default: cn])
   */
  async searchGroupsByName(
    cn: string,
    partial = false,
    attributes: string[] = [this.cn, 'member']
  ): Promise<LdapList> {
    const filter = partial ? `(${this.cn}=*${cn}*)` : `(${this.cn}=${cn})`;
    return await this.listGroups({ filter, attributes });
  }

  protected fixDn(dn: string): string | false {
    if (!dn) return false;
    return /,/.test(dn) ? dn : `${this.cn}=${dn},${this.base}`;
  }

  /**
   * Verify that each member exists in LDAP
   *
   * It calls ldapgroupvalidatemembers hook before validation
   * so that plugins can modify the members list and/or the group DN
   * and/or create missing members on the fly
   * @param dn Group DN (given to hooks)
   * @param members Array of member DNs to check
   * @returns nothing, throw if error
   */
  async validateMembers(dn: string, members: string[]): Promise<void> {
    [dn, members] = await launchHooksChained(
      this.server.hooks.ldapgroupvalidatemembers,
      [dn, members]
    );
    if (this.config.groups_allow_unexistent_members) return;
    if (!members || !members.length) return;
    try {
      // Parallelize member validation with global concurrency limit
      await Promise.all(
        members.map(m =>
          this.server.ldap.queryLimit(async () => {
            try {
              await this.ldap.search({ paged: false, scope: 'base' }, m);
            } catch (e) {
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new Error(`Member ${m} not found: ${e}`);
            }
          })
        )
      );
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to find member(s): ${err}`);
    }
  }

  async validateNewGroup(dn: string, entry: AttributesList): Promise<boolean> {
    if (!this.schema) return true;
    [dn, entry] = await launchHooksChained(
      this.server.hooks.ldapgroupvalidatenew,
      [dn, entry]
    );
    // Check each field
    for (const [field, value] of Object.entries(entry)) {
      if (!(await this._validateOneChange(field, value))) {
        throw new Error(`Invalid value for field ${field}`);
      }
    }
    // Check required fields
    for (const [field, test] of Object.entries(this.schema.attributes)) {
      if (test.required && entry[field] == undefined)
        throw new Error(`Missing required field ${field}`);
    }
    return true;
  }

  async validateChanges(dn: string, changes: ModifyRequest): Promise<boolean> {
    if (!this.schema) return true;
    [dn, changes] = await launchHooksChained(
      this.server.hooks.ldapgroupvalidatechanges,
      [dn, changes]
    );
    if (changes.add) {
      for (const [field, value] of Object.entries(changes.add)) {
        await this._validateOneChange(field, value);
      }
    }
    if (changes.replace) {
      for (const [field, value] of Object.entries(changes.replace)) {
        await this._validateOneChange(field, value);
      }
    }
    if (changes.delete && changes.delete instanceof Object) {
      for (const v of Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete)) {
        await this._validateOneChange(v, null);
      }
    }
    return true;
  }

  async _validateOneChange(
    field: string,
    value: AttributeValue | null
  ): Promise<boolean> {
    if (!this.schema) return true;
    const test = this.schema.attributes[field];
    if (!test) {
      if (this.schema.strict) throw new Error(`Field ${field} is not allowed`);
      return true;
    }
    if (value === null || value === undefined) {
      if (test.required) throw new Error(`Field ${field} is required`);
      return true;
    }
    if (test.type === 'array') {
      if (!Array.isArray(value))
        throw new Error(`Field ${field} must be an array`);
      if (!test.items)
        throw new Error(`Schema error: no item for array ${field}`);
      if (test.items.type === 'array')
        throw new Error(
          `Schema error: array of array not supported for ${field}`
        );
      if (test.items.test) {
        if (typeof test.items.test === 'string')
          test.items.test = new RegExp(test.items.test);
        for (let v of value) {
          if (typeof v !== test.items.type)
            throw new Error(
              `Field ${field} must be of type ${test.items.type}`
            );
          if (typeof v !== 'string') v = v.toString();
          if (test.items.test && !test.items.test.test(v))
            throw new Error(`Field ${field} has invalid value ${v}`);
        }
      }
    } else if (test.type === 'pointer') {
      if (typeof value !== 'string')
        throw new Error(`Field ${field} must be a string (DN pointer)`);

      const dnValue: string = value;

      // Check branch restriction if provided
      if (test.branch && test.branch.length > 0) {
        const isInBranch = test.branch.some(branch => {
          const branchPattern = new RegExp(
            `,?${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            'i'
          );
          return branchPattern.test(dnValue);
        });
        if (!isInBranch) {
          throw new Error(
            `Field ${field} must point to a DN within allowed branches: ${test.branch.join(', ')}`
          );
        }
      }

      // Verify that the DN exists in LDAP (will use cache)
      try {
        const result = (await this.ldap.search(
          { paged: false, scope: 'base' },
          dnValue
        )) as SearchResult;
        if (
          !result ||
          !result.searchEntries ||
          result.searchEntries.length === 0
        )
          throw new Error(
            `Field ${field} points to non-existent DN: ${dnValue}`
          );
      } catch (err) {
        throw new Error(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `Field ${field} points to invalid or non-existent DN: ${dnValue}: ${err}`
        );
      }
      // Also check test regex if provided
      if (test.test) {
        if (typeof test.test === 'string') test.test = new RegExp(test.test);
        if (test.test && !test.test.test(dnValue))
          throw new Error(`Field ${field} has invalid value ${dnValue}`);
      }
    } else {
      if (typeof value !== test.type) return false;
      if (typeof value !== 'string') value = value.toString();
      if (test.test) {
        if (typeof test.test === 'string') test.test = new RegExp(test.test);
        if (test.test && !test.test.test(value))
          throw new Error(`Field ${field} has invalid value ${value}`);
      }
    }
    return true;
  }

  /**
   * Provide configuration for config API
   */
  getConfigApiData(): Record<string, unknown> {
    const apiPrefix = this.config.api_prefix || '/api';

    // Generate schema URL if static plugin is loaded
    let schemaUrl: string | undefined;
    if (this.server.loadedPlugins['static'] && this.config.group_schema) {
      const staticName = this.config.static_name || 'static';
      const schemasIndex = this.config.group_schema.indexOf('/schemas/');
      if (schemasIndex !== -1) {
        const relativePath = this.config.group_schema.substring(schemasIndex);
        schemaUrl = `/${staticName}${relativePath}`;
      }
    }

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
