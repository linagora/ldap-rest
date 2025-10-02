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

import DmPlugin from '../../abstract/plugin';
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
          key !== this.cn && key !== 'member' && _value !== undefined
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
    await tryMethod(res, this.modifyGroup.bind(this), dn, body);
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
    let entry: AttributesList = {
      // Classes from --group-class
      objectClass: this.config.group_class as string[],
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
      await Promise.all(
        members.map(async m => {
          try {
            await this.ldap.search({ paged: false }, m);
          } catch (e) {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            throw new Error(`Member ${m} not found: ${e}`);
          }
        })
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
      if (!this._validateOneChange(field, value)) {
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
        this._validateOneChange(field, value);
      }
    }
    if (changes.replace) {
      for (const [field, value] of Object.entries(changes.replace)) {
        this._validateOneChange(field, value);
      }
    }
    if (changes.delete && changes.delete instanceof Object) {
      for (const v of Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete)) {
        this._validateOneChange(v, null);
      }
    }
    return true;
  }

  _validateOneChange(field: string, value: AttributeValue | null): boolean {
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
}
