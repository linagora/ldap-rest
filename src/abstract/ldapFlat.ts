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
  created,
  jsonBody,
  tryMethod,
  wantJson,
} from '../lib/expressFormatedResponses';
import {
  asyncHandler,
  launchHooks,
  launchHooksChained,
  transformSchemas,
} from '../lib/utils';
import type { Schema } from '../config/schema';
import { BadRequestError, NotFoundError, ConflictError } from '../lib/errors';

import DmPlugin from './plugin';

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
  private regexCache = new Map<string, RegExp>();

  /**
   * Get a compiled RegExp from cache, or compile and cache it
   */
  protected getCompiledRegex(pattern: string, flags?: string): RegExp {
    const key = flags ? `${pattern}:${flags}` : pattern;
    let regex = this.regexCache.get(key);
    if (!regex) {
      regex = new RegExp(pattern, flags);
      this.regexCache.set(key, regex);
    }
    return regex;
  }

  /**
   * Escape special regex characters in a string
   */
  protected escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

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
      try {
        const data = fs.readFileSync(config.schemaPath, 'utf8');
        this.schema = JSON.parse(transformSchemas(data, this.config)) as Schema;
        this.logger.info(
          `${this.singularName} schema loaded from ${config.schemaPath}`
        );
      } catch (err) {
        this.logger.error(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `Failed to load ${this.singularName} schema from ${config.schemaPath}: ${err}`
        );
      }
    }
  }

  /**
   * API routes
   */
  api(app: Express): void {
    // List entries
    app.get(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      asyncHandler(async (req, res) => {
        if (!wantJson(req, res)) return;
        const args: { filter?: string; attributes?: string[] } = {};
        if (
          req.query.match &&
          typeof req.query.match === 'string' &&
          req.query.attribute &&
          typeof req.query.attribute === 'string'
        ) {
          args.filter = `(${req.query.attribute}=*${req.query.match}*)`;
        }
        if (req.query.attributes && typeof req.query.attributes === 'string') {
          args.attributes = req.query.attributes.split(',');
        }
        const list = await this.listEntries(args);
        res.json(list);
      })
    );

    // Get entry by id or DN
    app.get(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      asyncHandler(async (req, res) => this.apiGet(req, res))
    );

    // Add entry
    app.post(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      asyncHandler(async (req, res) => this.apiAdd(req, res))
    );

    // Delete entry
    app.delete(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      asyncHandler(async (req, res) => this.apiDelete(req, res))
    );

    // Modify entry
    app.put(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      asyncHandler(async (req, res) => this.apiModify(req, res))
    );

    // Move entry to different organization
    app.post(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id/move`,
      asyncHandler(async (req, res) => this.apiMove(req, res))
    );
  }

  async apiGet(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const id = decodeURIComponent(req.params.id as string);
    try {
      const dn = /,/.test(id) ? id : `${this.mainAttribute}=${id},${this.base}`;
      const result = (await this.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
      if (result.searchEntries.length === 0) {
        throw new NotFoundError(`${this.singularName} not found`);
      }
      res.json(result.searchEntries[0]);
    } catch (err) {
      // LDAP NoSuchObjectError (code 32) means not found
      if (
        (err as { code?: number }).code &&
        (err as { code?: number }).code === 32
      ) {
        throw new NotFoundError(`${this.singularName} not found`);
      }
      throw err;
    }
  }

  async apiAdd(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res, this.mainAttribute) as
      | Record<string, AttributeValue>
      | false;
    if (!body) return;

    const id = body[this.mainAttribute] as string;
    const additional = { ...body };
    delete additional[this.mainAttribute];
    // Remove dn if provided - it will be constructed by addEntry
    delete additional.dn;

    await this.addEntry(id, additional, req);
    const entry = await this.searchEntriesByName(id, false);
    return created(res, entry[id]);
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const id = decodeURIComponent(req.params.id as string);
    await tryMethod(res, this.deleteEntry.bind(this), id);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as ModifyRequest | false;
    if (!body) return;
    const id = decodeURIComponent(req.params.id as string);
    await tryMethod(res, this.modifyEntry.bind(this), id, body);
  }

  async apiMove(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const body = jsonBody(req, res, 'targetOrgDn') as
      | { targetOrgDn: string }
      | false;
    if (!body) return;

    const id = decodeURIComponent(req.params.id as string);
    const { targetOrgDn } = body;

    if (!targetOrgDn || typeof targetOrgDn !== 'string') {
      throw new BadRequestError(
        'Missing or invalid targetOrgDn in request body'
      );
    }

    const result = await this.moveEntry(id, targetOrgDn, req);
    res.json({
      success: true,
      ...result,
    });
  }

  async addEntry(
    id: string,
    additional: AttributesList = {},
    req?: Request
  ): Promise<boolean> {
    let dn: string;
    if (new RegExp(`^${this.mainAttribute}=`).test(id)) {
      // DN provided - validate it's in the correct flat branch
      dn = id;
      const expectedSuffix = `,${this.base}`;
      if (!dn.endsWith(expectedSuffix)) {
        throw new BadRequestError(
          `DN must be in the flat branch "${this.base}". ` +
            `Provided DN "${dn}" does not end with "${expectedSuffix}"`
        );
      }
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

    // Note: LDAP attribute values with DNs do NOT need escaping
    // ldapts handles this automatically
    // Only the main DN of the entry itself needs proper formatting
    if (this.schema) {
      this.logger.debug(
        'Schema loaded, attributes:',
        Object.keys(this.schema.attributes)
      );
    } else {
      this.logger.warn('No schema available');
    }

    [dn, entry] = await launchHooksChained(
      this.registeredHooks[`${this.hookPrefix}add`],
      [dn, entry]
    );

    // Debug log entry before sending to LDAP
    this.logger.debug('Adding LDAP entry:', {
      dn,
      entry: JSON.stringify(entry, null, 2),
    });

    // Log each attribute to see exact values
    this.logger.debug('Entry attributes breakdown:');
    for (const [key, value] of Object.entries(entry)) {
      this.logger.debug(`  ${key}: ${typeof value} = ${JSON.stringify(value)}`);
    }

    let res;
    try {
      res = await this.ldap.add(dn, entry, req);
    } catch (err) {
      // Log detailed error information
      this.logger.error('LDAP add failed:', {
        dn,
        entry: JSON.stringify(entry, null, 2),
        error: err,
      });
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
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
        throw new ConflictError(
          `${this.mainAttribute} attribute is unique, cannot add`
        );
    }
    if (changes.delete) {
      if (changes.delete instanceof Object) {
        if ((changes.delete as AttributesList)[this.mainAttribute])
          throw new BadRequestError(
            `Cannot delete ${this.mainAttribute} attribute`
          );
      }
      if (Array.isArray(changes.delete)) {
        if (changes.delete.includes(this.mainAttribute))
          throw new BadRequestError(
            `Cannot delete ${this.mainAttribute} attribute`
          );
      }
    }
    if (changes.replace) {
      if (changes.replace[this.mainAttribute])
        throw new BadRequestError(
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
   * Move entry to a different organization
   * Updates department link and path attributes
   */
  async moveEntry(
    id: string,
    targetOrgDn: string,
    req?: Request
  ): Promise<{ departmentPath: string; departmentLink: string }> {
    const dn = /,/.test(id) ? id : `${this.mainAttribute}=${id},${this.base}`;

    // Get link and path attribute names from config
    const linkAttr =
      this.config.ldap_organization_link_attribute || 'twakeDepartmentLink';
    const pathAttr =
      this.config.ldap_organization_path_attribute || 'twakeDepartmentPath';

    // Validate that the schema supports these attributes
    if (
      !this.schema?.attributes[linkAttr] ||
      !this.schema?.attributes[pathAttr]
    ) {
      throw new BadRequestError(
        `Schema for ${this.singularName} does not support move operation (missing ${linkAttr} or ${pathAttr})`
      );
    }

    // Fetch current entry to get old organization
    const currentEntry = (await this.ldap.search(
      { paged: false, scope: 'base', attributes: [linkAttr] },
      dn,
      req
    )) as SearchResult;

    if (
      !currentEntry.searchEntries ||
      currentEntry.searchEntries.length === 0
    ) {
      throw new NotFoundError(`Entry ${dn} not found`);
    }

    // Get department path from target organization
    const departmentPath = await this.getDepartmentPath(targetOrgDn, req);

    // Launch pre-move hook (chained - can modify targetOrgDn or cancel)
    [, targetOrgDn] = await launchHooksChained(
      this.registeredHooks[`${this.hookPrefix}move`],
      [dn, targetOrgDn, req]
    );

    // Prepare LDAP modify request
    const changes: ModifyRequest = {
      replace: {
        [linkAttr]: targetOrgDn,
        [pathAttr]: departmentPath,
      },
    };

    // Execute the modification (will trigger onLdapChange hook)
    await this.modifyEntry(id, changes);

    return {
      departmentPath,
      departmentLink: targetOrgDn,
    };
  }

  /**
   * Get department path from an organization DN
   * Fetches the path attribute directly from the organization entry
   */
  private async getDepartmentPath(
    orgDn: string,
    req?: Request
  ): Promise<string> {
    const pathAttr =
      this.config.ldap_organization_path_attribute || 'twakeDepartmentPath';

    try {
      const result = (await this.ldap.search(
        { paged: false, scope: 'base', attributes: [pathAttr, 'ou', 'o'] },
        orgDn,
        req
      )) as SearchResult;

      if (!result.searchEntries || result.searchEntries.length === 0) {
        throw new NotFoundError(`Organization ${orgDn} not found`);
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

    // First, enforce fixed attributes
    for (const [field, attr] of Object.entries(this.schema.attributes)) {
      if (attr.fixed && attr.default !== undefined) {
        // Force the default value for fixed attributes
        entry[field] = attr.default;
      }
    }

    for (const [field, value] of Object.entries(entry)) {
      if (!this.schema.attributes[field]) {
        if (this.schema.strict)
          throw new BadRequestError(
            `Unknown attribute "${field}" for ${this.singularName}`
          );
        continue;
      }
      const attr = this.schema.attributes[field];

      // Check if trying to modify a fixed attribute
      if (attr.fixed && attr.default !== undefined) {
        const defaultStr = JSON.stringify(attr.default);
        const valueStr = JSON.stringify(value);
        if (defaultStr !== valueStr) {
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be modified. Expected: ${defaultStr}`
          );
        }
      }

      if (!(await this._validateOneChange(field, value))) {
        throw new BadRequestError(`Invalid value for attribute "${field}"`);
      }
      if (attr.required && !value) {
        throw new BadRequestError(`Attribute "${field}" is required`);
      }
    }
    // Check required fields
    for (const [field, attr] of Object.entries(this.schema.attributes)) {
      if (attr.required && !entry[field]) {
        throw new BadRequestError(`Attribute "${field}" is required`);
      }
    }
    return true;
  }

  async validateChanges(dn: string, changes: ModifyRequest): Promise<boolean> {
    if (!this.schema) return true;

    // Check for fixed attributes in add/replace operations
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const checkFixed = (field: string, value: AttributeValue): void => {
      const attr = this.schema?.attributes[field];
      if (attr?.fixed) {
        throw new BadRequestError(
          `Attribute "${field}" is fixed and cannot be modified`
        );
      }
    };

    if (changes.add) {
      for (const [field, value] of Object.entries(changes.add)) {
        checkFixed(field, value);
        if (!(await this._validateOneChange(field, value))) {
          throw new BadRequestError(`Invalid value for attribute "${field}"`);
        }
      }
    }
    if (changes.replace) {
      for (const [field, value] of Object.entries(changes.replace)) {
        checkFixed(field, value);
        if (!(await this._validateOneChange(field, value))) {
          throw new BadRequestError(`Invalid value for attribute "${field}"`);
        }
      }
    }
    if (changes.delete) {
      const deleteFields = Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete);
      for (const field of deleteFields) {
        const attr = this.schema.attributes[field];
        if (attr?.fixed) {
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be deleted`
          );
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
    const attr = this.schema.attributes[field];
    if (!attr) {
      if (this.schema.strict) return false;
      return true;
    }
    if (!value) return true;

    // Handle pointer type
    if (attr.type === 'pointer') {
      if (typeof value !== 'string') {
        throw new BadRequestError(
          `Field ${field} must be a string (DN pointer)`
        );
      }

      const dnValue: string = value;

      // Check branch restriction if provided
      if (attr.branch && attr.branch.length > 0) {
        const isInBranch = attr.branch.some(branch => {
          const branchPattern = this.getCompiledRegex(
            `,?${this.escapeRegex(branch)}$`,
            'i'
          );
          return branchPattern.test(dnValue);
        });
        if (!isInBranch) {
          throw new BadRequestError(
            `Field ${field} must point to a DN within allowed branches: ${attr.branch.join(', ')}`
          );
        }
      }

      // Verify that the DN exists in LDAP
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
          throw new BadRequestError(
            `Field ${field} points to non-existent DN: ${dnValue}`
          );
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (err) {
        throw new BadRequestError(
          `Field ${field} points to invalid or non-existent DN: ${dnValue}`
        );
      }
    }

    if (attr.test) {
      const regex =
        typeof attr.test === 'string'
          ? this.getCompiledRegex(attr.test)
          : attr.test;
      if (Array.isArray(value)) {
        return value.every(v => regex.test(v as string));
      }
      return regex.test(value as string);
    }
    return true;
  }
}
