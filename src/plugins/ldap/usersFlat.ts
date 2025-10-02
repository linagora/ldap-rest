/**
 * @module plugins/ldap/usersFlat
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Plugin to manage users in a flat LDAP branch
 * - add/delete users
 * - modify users
 */
import fs from 'fs';

import type { Express, Request, Response } from 'express';

import DmPlugin from '../../abstract/plugin';
import type { DM } from '../../bin';
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
  uid?: string;
  [key: string]: AttributeValue | undefined;
}
export type postModify = ModifyRequest;

export default class LdapUsersFlat extends DmPlugin {
  name = 'ldapUsersFlat';
  base?: string;
  ldap: ldapActions;
  uid: string;
  schema?: Schema;

  constructor(server: DM) {
    super(server);
    this.ldap = server.ldap;
    this.base = this.config.ldap_user_branch as string;
    this.uid = this.config.ldap_user_main_attribute as string;
    if (!this.base) {
      this.base = this.config.ldap_base;
      this.logger.warn(`LDAP user branch is not defined, using "${this.base}"`);
    }
    if (!this.base) {
      throw new Error(
        'LDAP base is not defined, please set --ldap-user-branch'
      );
    }
    if (this.config.user_schema) {
      fs.readFile(this.config.user_schema, (err, data) => {
        if (err) {
          this.logger.error(
            // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions
            `Failed to load user schema from ${this.config.user_schema}: ${err}`
          );
        } else {
          try {
            this.schema = JSON.parse(
              transformSchemas(data.toString(), this.config)
            ) as Schema;
            this.logger.debug('User schema loaded');
          } catch (e) {
            this.logger.error(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Failed to parse ${this.config.schemas_path}/users.json: ${e}`
            );
          }
        }
      });
    }
  }

  /**
   * API routes
   */

  api(app: Express): void {
    // List users
    app.get(`${this.config.api_prefix}/v1/ldap/users`, async (req, res) => {
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
            : `(${this.uid}=${req.query.match})`;
        if (req.query.attributes && typeof req.query.attributes === 'string')
          args.attributes = req.query.attributes.split(',');
        const list = await this.listUsers(args);
        return ok(res, list);
      } catch (err) {
        return serverError(res, err);
      }
    });

    // Add user
    app.post(`${this.config.api_prefix}/v1/ldap/users`, async (req, res) =>
      this.apiAdd(req, res, this.uid)
    );

    // Delete user
    app.delete(
      `${this.config.api_prefix}/v1/ldap/users/:uid`,
      async (req, res) => this.apiDelete(req, res)
    );

    // Modify user
    app.put(`${this.config.api_prefix}/v1/ldap/users/:uid`, async (req, res) =>
      this.apiModify(req, res)
    );
  }

  async apiAdd(
    req: Request,
    res: Response,
    ...requiredFields: string[]
  ): Promise<void> {
    const body = jsonBody(req, res, ...requiredFields) as postAdd | false;
    if (!body) return;
    const uid = body[this.uid];
    const additional: AttributesList = Object.fromEntries(
      Object.entries(body).filter(
        ([key, _value]) => key !== this.uid && _value !== undefined
      )
    ) as AttributesList;
    await tryMethod(res, this.addUser.bind(this), uid, additional);
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const uid = decodeURIComponent(req.params.uid);
    if (!uid) return badRequest(res, 'uid is required');
    await tryMethod(res, this.deleteUser.bind(this), uid);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as postModify | false;
    if (!body) return;
    const dn = this.fixDn(decodeURIComponent(req.params.uid));
    if (!dn) return badRequest(res);
    await tryMethod(res, this.modifyUser.bind(this), dn, body);
  }

  /**
   * LDAP user methods
   */

  async addUser(
    uid: string,
    additional: AttributesList = {}
  ): Promise<boolean> {
    let dn: string;
    if (new RegExp(`^${this.uid}=`).test(uid)) {
      dn = uid;
      uid = uid.replace(new RegExp(`^${this.uid}=([^,]+).*`), '$1');
    } else {
      dn = `${this.uid}=${uid},${this.base}`;
    }
    await this.validateNewUser(dn, {
      objectClass: this.config.user_class as string[],
      [this.uid]: uid,
      ...additional,
    });

    // Build entry
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    let entry: AttributesList = {
      // Classes from --user-class
      objectClass: this.config.user_class as string[],
      // Default attributes from --user-default-attributes
      ...this.config.user_default_attributes,
      // uid calculated here
      [this.uid]: uid,
      ...additional,
    };
    [dn, entry] = await launchHooksChained(this.registeredHooks.ldapuseradd, [
      dn,
      entry,
    ]);
    let res;
    try {
      res = await this.ldap.add(dn, entry);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Failed to add user ${dn}: ${err}`);
    }
    void launchHooks(this.registeredHooks.ldapuseradddone, [dn, entry]);
    return res;
  }

  async modifyUser(
    uid: string,
    changes: {
      add?: AttributesList;
      replace?: AttributesList;
      delete?: string[] | AttributesList;
    }
  ): Promise<boolean> {
    let dn = /,/.test(uid) ? uid : `${this.uid}=${uid},${this.base}`;
    const op = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.registeredHooks.ldapusermodify,
      [dn, changes, op]
    );
    if (changes.add) {
      if (changes.add[this.uid])
        throw new Error(`${this.uid} attribute is unique, cannot add`);
    }
    if (changes.delete) {
      if (changes.delete instanceof Object) {
        if ((changes.delete as AttributesList)[this.uid])
          throw new Error(`Cannot delete ${this.uid} attribute`);
      }
      if (Array.isArray(changes.delete)) {
        if (changes.delete.includes(this.uid))
          throw new Error(`Cannot delete ${this.uid} attribute`);
      }
    }
    if (changes.replace) {
      if (changes.replace[this.uid])
        throw new Error(`Use dedicated API to change ${this.uid} attribute`);
    }

    await this.validateChanges(dn, changes);
    const res = await this.ldap.modify(dn, changes);
    void launchHooks(this.registeredHooks.ldapusermodifydone, [
      dn,
      changes,
      op,
    ]);
    return res;
  }

  async renameUser(uid: string, newUid: string): Promise<boolean> {
    let dn = /,/.test(uid) ? uid : `${this.uid}=${uid},${this.base}`;
    let newDn = /,/.test(newUid)
      ? newUid
      : `${this.uid}=${newUid},${this.base}`;
    [dn, newDn] = await launchHooksChained(
      this.registeredHooks.ldapuserrename,
      [dn, newDn]
    );
    const res = await this.ldap.rename(dn, newDn);
    void launchHooks(this.registeredHooks.ldapuserrenamedone, [dn, newDn]);
    return res;
  }

  async deleteUser(uid: string): Promise<boolean> {
    let dn = /,/.test(uid) ? uid : `${this.uid}=${uid},${this.base}`;
    dn = await launchHooksChained(this.registeredHooks.ldapuserdelete, dn);
    const res = await this.ldap.delete(dn);
    void launchHooks(this.registeredHooks.ldapuserdeletedone, dn);
    return res;
  }

  /**
   * List users from LDAP
   * @param param0 {filter, attributes}:
   * - filter: LDAP filter (default '(objectClass=*)')
   * - attributes: attributes to fetch (default ['uid'])
   * @returns LdapList (Record<string, AttributesList>)
   */
  async listUsers({
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
          attributes: attributes || [this.uid],
          paged: true,
        },
        this.base as string
      )
      .catch(err => {
        throw new Error(`Failed to list users from ${this.base}: ${err}`);
      })) as AsyncGenerator<SearchResult>;
    let entries: LdapList = {};
    for await (const r of _res) {
      r.searchEntries.map(entry => {
        const s = entry[this.uid] as string;
        if (s) entries[s] = entry;
      });
    }

    entries = await launchHooksChained(
      this.registeredHooks._ldapuserlist,
      entries
    );
    return entries;
  }

  /**
   * Simple formatter for listUsers()
   * @param uid main attribute value (partial or full)
   * @param partial boolean, true for partial search (default false)
   * @param attributes array of attributes to return
   * @returns LdapList (means Record<string, AttributesList> where key is the --ldap-user-main-attribute value [default: uid])
   */
  async searchUsersByName(
    uid: string,
    partial = false,
    attributes: string[] = [this.uid]
  ): Promise<LdapList> {
    const filter = partial ? `(${this.uid}=*${uid}*)` : `(${this.uid}=${uid})`;
    return await this.listUsers({ filter, attributes });
  }

  protected fixDn(dn: string): string | false {
    if (!dn) return false;
    return /,/.test(dn) ? dn : `${this.uid}=${dn},${this.base}`;
  }

  async validateNewUser(dn: string, entry: AttributesList): Promise<boolean> {
    if (!this.schema) return true;
    [dn, entry] = await launchHooksChained(
      this.server.hooks.ldapuservalidatenew,
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
      this.server.hooks.ldapuservalidatechanges,
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
