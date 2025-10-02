/**
 * @module abstract/ldapFlat
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Abstract class to manage LDAP entries in a flat branch
 * - add/delete entries
 * - modify entries
 * - validate with schema
 */
import fs from 'fs';

import type { Express, Request, Response } from 'express';

import DmPlugin from './plugin';
import type { DM } from '../bin';
import type ldapActions from '../lib/ldapActions';
import type {
  AttributesList,
  AttributeValue,
  LdapList,
  ModifyRequest,
  SearchResult,
} from '../lib/ldapActions';
import {
  badRequest,
  created,
  jsonBody,
  ok,
  serverError,
  tryMethod,
  wantJson,
} from '../lib/expressFormatedResponses';
import {
  launchHooks,
  launchHooksChained,
  transformSchemas,
} from '../lib/utils';
import type { Schema } from '../config/schema';

export interface LdapFlatConfig {
  /**
   * LDAP branch where entries are stored
   */
  base: string;

  /**
   * Main attribute used as entry identifier (e.g., 'uid', 'cn')
   */
  mainAttribute: string;

  /**
   * ObjectClass(es) for new entries
   */
  objectClass: string[];

  /**
   * Default attributes to add to new entries
   */
  defaultAttributes?: AttributesList;

  /**
   * Optional schema file path for validation
   */
  schemaPath?: string;

  /**
   * Singular name for API routes (e.g., 'user', 'position')
   */
  singularName: string;

  /**
   * Plural name for API routes (e.g., 'users', 'positions')
   */
  pluralName: string;

  /**
   * Hook name prefix (e.g., 'ldapuser', 'ldapposition')
   */
  hookPrefix: string;
}

export default abstract class LdapFlat extends DmPlugin {
  base: string;
  ldap: ldapActions;
  mainAttribute: string;
  objectClass: string[];
  defaultAttributes: AttributesList;
  schema?: Schema;
  singularName: string;
  pluralName: string;
  hookPrefix: string;

  constructor(server: DM, config: LdapFlatConfig) {
    super(server);
    this.ldap = server.ldap;
    this.base = config.base;
    this.mainAttribute = config.mainAttribute;
    this.objectClass = config.objectClass;
    this.defaultAttributes = config.defaultAttributes || {};
    this.singularName = config.singularName;
    this.pluralName = config.pluralName;
    this.hookPrefix = config.hookPrefix;

    if (!this.base) {
      throw new Error(`LDAP base is not defined for ${this.singularName}`);
    }

    if (config.schemaPath) {
      fs.readFile(config.schemaPath, (err, data) => {
        if (err) {
          this.logger.error(
            `Failed to load ${this.singularName} schema from ${config.schemaPath}: ${err}`
          );
        } else {
          try {
            this.schema = JSON.parse(
              transformSchemas(data.toString(), this.config)
            ) as Schema;
            this.logger.debug(`${this.singularName} schema loaded`);
          } catch (e) {
            this.logger.error(`Failed to parse ${config.schemaPath}: ${e}`);
          }
        }
      });
    }
  }

  /**
   * API routes
   */
  api(app: Express): void {
    // List entries
    app.get(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      async (req, res) => {
        if (!wantJson(req, res)) return;
        try {
          const args: { filter?: string; attributes?: string[] } = {};
          if (
            req.query.match &&
            typeof req.query.match === 'string' &&
            req.query.attribute &&
            typeof req.query.attribute === 'string'
          ) {
            args.filter = `(${req.query.attribute}=*${req.query.match}*)`;
          }
          if (
            req.query.attributes &&
            typeof req.query.attributes === 'string'
          ) {
            args.attributes = req.query.attributes.split(',');
          }
          const list = await this.listEntries(args);
          res.json(list);
        } catch (err) {
          return serverError(res, err);
        }
      }
    );

    // Add entry
    app.post(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      async (req, res) => this.apiAdd(req, res)
    );

    // Delete entry
    app.delete(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      async (req, res) => this.apiDelete(req, res)
    );

    // Modify entry
    app.put(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      async (req, res) => this.apiModify(req, res)
    );
  }

  async apiAdd(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res, this.mainAttribute) as
      | Record<string, AttributeValue>
      | false;
    if (!body) return;

    const id = body[this.mainAttribute] as string;
    const additional = { ...body };
    delete additional[this.mainAttribute];

    try {
      await this.addEntry(id, additional);
      const entry = await this.searchEntriesByName(id, false);
      return created(res, entry[id]);
    } catch (err) {
      return serverError(res, err);
    }
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const id = decodeURIComponent(req.params.id);
    await tryMethod(res, this.deleteEntry.bind(this), id);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as ModifyRequest | false;
    if (!body) return;
    const id = decodeURIComponent(req.params.id);
    await tryMethod(res, this.modifyEntry.bind(this), id, body);
  }

  async addEntry(
    id: string,
    additional: AttributesList = {}
  ): Promise<boolean> {
    let dn: string;
    if (new RegExp(`^${this.mainAttribute}=`).test(id)) {
      dn = id;
      id = id.replace(new RegExp(`^${this.mainAttribute}=([^,]+).*`), '$1');
    } else {
      dn = `${this.mainAttribute}=${id},${this.base}`;
    }
    await this.validateNewEntry(dn, {
      objectClass: this.objectClass,
      [this.mainAttribute]: id,
      ...additional,
    });

    // Build entry
    let entry: AttributesList = {
      objectClass: this.objectClass,
      ...this.defaultAttributes,
      [this.mainAttribute]: id,
      ...additional,
    };
    [dn, entry] = await launchHooksChained(
      this.registeredHooks[`${this.hookPrefix}add`],
      [dn, entry]
    );
    let res;
    try {
      res = await this.ldap.add(dn, entry);
    } catch (err) {
      throw new Error(`Failed to add ${this.singularName} ${dn}: ${err}`);
    }
    void launchHooks(this.registeredHooks[`${this.hookPrefix}adddone`], [
      dn,
      entry,
    ]);
    return res;
  }

  async modifyEntry(id: string, changes: ModifyRequest): Promise<boolean> {
    let dn = /,/.test(id) ? id : `${this.mainAttribute}=${id},${this.base}`;
    const op = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.registeredHooks[`${this.hookPrefix}modify`],
      [dn, changes, op]
    );
    if (changes.add) {
      if (changes.add[this.mainAttribute])
        throw new Error(
          `${this.mainAttribute} attribute is unique, cannot add`
        );
    }
    if (changes.delete) {
      if (changes.delete instanceof Object) {
        if ((changes.delete as AttributesList)[this.mainAttribute])
          throw new Error(`Cannot delete ${this.mainAttribute} attribute`);
      }
      if (Array.isArray(changes.delete)) {
        if (changes.delete.includes(this.mainAttribute))
          throw new Error(`Cannot delete ${this.mainAttribute} attribute`);
      }
    }
    if (changes.replace) {
      if (changes.replace[this.mainAttribute])
        throw new Error(
          `Use dedicated API to change ${this.mainAttribute} attribute`
        );
    }

    await this.validateChanges(dn, changes);
    const res = await this.ldap.modify(dn, changes);
    void launchHooks(this.registeredHooks[`${this.hookPrefix}modifydone`], [
      dn,
      changes,
      op,
    ]);
    return res;
  }

  async renameEntry(id: string, newId: string): Promise<boolean> {
    let dn = /,/.test(id) ? id : `${this.mainAttribute}=${id},${this.base}`;
    let newDn = /,/.test(newId)
      ? newId
      : `${this.mainAttribute}=${newId},${this.base}`;
    [dn, newDn] = await launchHooksChained(
      this.registeredHooks[`${this.hookPrefix}rename`],
      [dn, newDn]
    );
    const res = await this.ldap.rename(dn, newDn);
    void launchHooks(this.registeredHooks[`${this.hookPrefix}renamedone`], [
      dn,
      newDn,
    ]);
    return res;
  }

  async deleteEntry(id: string): Promise<boolean> {
    let dn = /,/.test(id) ? id : `${this.mainAttribute}=${id},${this.base}`;
    dn = await launchHooksChained(
      this.registeredHooks[`${this.hookPrefix}delete`],
      dn
    );
    const res = await this.ldap.delete(dn);
    void launchHooks(this.registeredHooks[`${this.hookPrefix}deletedone`], dn);
    return res;
  }

  /**
   * List entries from LDAP
   */
  async listEntries({
    filter,
    attributes,
  }: {
    filter?: string;
    attributes?: string[];
  }): Promise<LdapList> {
    filter = filter || '(objectClass=*)';
    const args: {
      paged: boolean;
      filter: string;
      attributes?: string[];
    } = {
      paged: true,
      filter,
    };
    if (attributes && attributes.length > 0) args.attributes = attributes;
    const ldapRes = await this.ldap.search(args, this.base);
    const res: LdapList = {};
    for await (const tmp of ldapRes as AsyncGenerator<SearchResult>) {
      tmp.searchEntries.forEach(e => {
        if (e[this.mainAttribute]) {
          const value = e[this.mainAttribute];
          let id: string;
          if (Array.isArray(value)) {
            id = typeof value[0] === 'string' ? value[0] : String(value[0]);
          } else {
            id = typeof value === 'string' ? value : String(value);
          }
          res[id] = e;
        }
      });
    }
    return res;
  }

  async searchEntriesByName(
    name: string,
    partial = false,
    attrs: string[] = [this.mainAttribute]
  ): Promise<LdapList> {
    const filter = partial
      ? `(${this.mainAttribute}=*${name}*)`
      : `(${this.mainAttribute}=${name})`;
    return await this.listEntries({ filter, attributes: attrs });
  }

  async validateNewEntry(dn: string, entry: AttributesList): Promise<boolean> {
    if (!this.schema) return true;
    for (const [field, value] of Object.entries(entry)) {
      if (!this.schema.attributes[field]) {
        if (this.schema.strict)
          throw new Error(
            `Unknown attribute "${field}" for ${this.singularName}`
          );
        continue;
      }
      const attr = this.schema.attributes[field];
      if (!this._validateOneChange(field, value)) {
        throw new Error(`Invalid value for attribute "${field}"`);
      }
      if (attr.required && !value) {
        throw new Error(`Attribute "${field}" is required`);
      }
    }
    // Check required fields
    for (const [field, attr] of Object.entries(this.schema.attributes)) {
      if (attr.required && !entry[field]) {
        throw new Error(`Attribute "${field}" is required`);
      }
    }
    return true;
  }

  async validateChanges(dn: string, changes: ModifyRequest): Promise<boolean> {
    if (!this.schema) return true;
    if (changes.add) {
      for (const [field, value] of Object.entries(changes.add)) {
        if (!this._validateOneChange(field, value)) {
          throw new Error(`Invalid value for attribute "${field}"`);
        }
      }
    }
    if (changes.replace) {
      for (const [field, value] of Object.entries(changes.replace)) {
        if (!this._validateOneChange(field, value)) {
          throw new Error(`Invalid value for attribute "${field}"`);
        }
      }
    }
    return true;
  }

  _validateOneChange(field: string, value: AttributeValue | null): boolean {
    if (!this.schema) return true;
    const attr = this.schema.attributes[field];
    if (!attr) {
      if (this.schema.strict) return false;
      return true;
    }
    if (!value) return true;
    if (attr.test) {
      const regex = new RegExp(attr.test);
      if (Array.isArray(value)) {
        return value.every(v => regex.test(v as string));
      }
      return regex.test(value as string);
    }
    return true;
  }
}
