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
  escapeDnValue,
  escapeLdapFilter,
  escapeRegex,
  getCompiledRegex,
  getParentDn,
  isDnInBranch,
  launchHooks,
  launchHooksChained,
  substringSearchFilter,
  transformSchemas,
  validateDnValue,
} from '../lib/utils';
import type { Schema } from '../config/schema';
import { missingRequiredAttribute } from '../config/schema';
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
} from '../lib/errors';

import DmPlugin from './plugin';

/**
 * One attribute value or many, always as a list of strings.
 *
 * @param value value as the client sent it
 * @returns its elements
 */
function asList(value: AttributeValue): string[] {
  return (Array.isArray(value) ? value : [value]).map(item => String(item));
}

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

/**
 * Generic OpenAPI schemas for the flat LDAP-entry CRUD surface.
 * Every concrete plugin that extends LdapFlat (users, mailgroups, …)
 * exposes these shapes, with `mainAttribute` and concrete attribute
 * names varying per instance.
 *
 * @openapi-component
 * FlatEntry:
 *   type: object
 *   description: |
 *     A single LDAP entry from a flat branch. The `dn` field is always
 *     present; all other fields depend on the concrete plugin's schema
 *     (e.g. `uid`, `cn`, `mail`, `sn` for users).
 *   required: [dn]
 *   properties:
 *     dn:
 *       type: string
 *       description: Fully-qualified distinguished name of the entry.
 *       example: uid=alice,ou=users,dc=example,dc=com
 *   additionalProperties:
 *     oneOf:
 *       - type: string
 *       - type: array
 *         items: { type: string }
 *   example:
 *     dn: uid=alice,ou=users,dc=example,dc=com
 *     uid: alice
 *     cn: Alice Smith
 *     sn: Smith
 *     mail: alice@example.com
 * FlatList:
 *   type: object
 *   description: |
 *     A map of entries returned by the LIST endpoint, keyed by the
 *     entry's `mainAttribute` value (e.g. the `uid` for users). This
 *     is the `LdapList` shape (`Record<string, FlatEntry>`).
 *   additionalProperties:
 *     $ref: '#/components/schemas/FlatEntry'
 *   example:
 *     alice:
 *       dn: uid=alice,ou=users,dc=example,dc=com
 *       uid: alice
 *       cn: Alice Smith
 *       mail: alice@example.com
 *     bob:
 *       dn: uid=bob,ou=users,dc=example,dc=com
 *       uid: bob
 *       cn: Bob Jones
 *       mail: bob@example.com
 * FlatCreate:
 *   type: object
 *   description: |
 *     Body for creating a new entry. The plugin's `mainAttribute` field
 *     (e.g. `uid`) is required and used to build the DN. All other
 *     attributes are plugin-specific; unknown attributes are accepted
 *     unless the plugin's schema is in strict mode.
 *   additionalProperties: true
 *   example:
 *     uid: carol
 *     cn: Carol White
 *     sn: White
 *     mail: carol@example.com
 * FlatModify:
 *   type: object
 *   description: |
 *     Partial-update body. Supports `add`, `replace`, and `delete`
 *     maps matching the LDAP modify operation. The `mainAttribute`
 *     (e.g. `uid`) cannot be changed through this endpoint — use the
 *     rename API instead.
 *   properties:
 *     add:
 *       type: object
 *       description: Attributes whose values are appended.
 *       additionalProperties: true
 *     replace:
 *       type: object
 *       description: Attributes whose values are replaced wholesale.
 *       additionalProperties: true
 *     delete:
 *       description: |
 *         Attributes (or specific values) to remove. Either an array
 *         of attribute names or a map of attribute → value(s).
 *       oneOf:
 *         - type: array
 *           items: { type: string }
 *         - type: object
 *           additionalProperties: true
 *   example:
 *     replace:
 *       mail: carol.white@example.com
 *       cn: Carol White-Smith
 * FlatMoveRequest:
 *   type: object
 *   description: |
 *     Body for moving an entry to a different organisational unit.
 *     Requires `ldap_organization_link_attribute` and
 *     `ldap_organization_path_attribute` to be defined in the plugin's
 *     schema.
 *   required: [targetOrgDn]
 *   properties:
 *     targetOrgDn:
 *       type: string
 *       description: DN of the destination organisational unit.
 *       example: ou=engineering,ou=departments,dc=example,dc=com
 *   example:
 *     targetOrgDn: ou=engineering,ou=departments,dc=example,dc=com
 */
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
   * Attributes a client is not allowed to supply: those the server computes
   * (`generated`) and those it only ever derives from elsewhere (`readOnly`,
   * such as `memberOf`, which is driven from the group side).
   *
   * The core and its plugins still write them — the restriction is on the
   * request body, not on the entry.
   *
   * @returns lowercased attribute names
   */
  protected clientForbiddenAttributes(): Set<string> {
    const forbidden = new Set<string>();
    if (!this.schema) return forbidden;
    for (const [name, attr] of Object.entries(this.schema.attributes)) {
      // A `generated` identifier with no derivation rule has nothing to be
      // generated from: the client still has to supply it.
      if (name === this.mainAttribute && !attr.generatedFrom) continue;
      if (attr.generated || attr.readOnly) forbidden.add(name.toLowerCase());
    }
    return forbidden;
  }

  /**
   * Attributes never sent back over the API. A manager may reset a password
   * without being able to read it back: the asymmetry is a projection, not an
   * authorization rule, so it lives with the schema.
   *
   * @returns lowercased attribute names
   */
  protected hiddenAttributes(): Set<string> {
    const hidden = new Set<string>();
    if (!this.schema) return hidden;
    for (const [name, attr] of Object.entries(this.schema.attributes)) {
      if (attr.neverReturn) hidden.add(name.toLowerCase());
    }
    return hidden;
  }

  /**
   * Remove the `neverReturn` attributes from an entry about to be serialised.
   * LDAP attribute names are case-insensitive and may carry options
   * (`userPassword;binary`), so both are normalised before comparison.
   *
   * @param entry entry as read from the directory
   * @returns a copy without the hidden attributes
   */
  protected project<T extends Record<string, unknown>>(entry: T): T {
    const hidden = this.hiddenAttributes();
    if (hidden.size === 0) return entry;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(entry)) {
      if (hidden.has(name.split(';')[0].toLowerCase())) continue;
      out[name] = value;
    }
    return out as T;
  }

  /**
   * Same as {@link project}, for a map of entries keyed by identifier.
   *
   * @param list entries as read from the directory
   * @returns a copy without the hidden attributes
   */
  protected projectList(list: LdapList): LdapList {
    if (this.hiddenAttributes().size === 0) return list;
    const out: LdapList = {};
    for (const [id, entry] of Object.entries(list))
      out[id] = this.project(entry);
    return out;
  }

  /**
   * Refuse a request body that carries an attribute the client may not set.
   *
   * Failing loudly matters more than ignoring the value: a client that sends
   * `twakeDepartmentPath` believes it is setting the path, and silently
   * overwriting it with the computed one would leave it thinking otherwise.
   *
   * @param names attribute names present in the request
   * @throws BadRequestError naming the first offending attribute
   */
  protected rejectForbiddenInput(names: string[]): void {
    const forbidden = this.clientForbiddenAttributes();
    if (forbidden.size === 0) return;
    for (const name of names) {
      if (name === 'dn') continue;
      if (!forbidden.has(name.split(';')[0].toLowerCase())) continue;
      const attr = this.schema?.attributes[name];
      throw new BadRequestError(
        attr?.readOnly
          ? `Attribute "${name}" is read-only and cannot be set`
          : `Attribute "${name}" is computed by the server and cannot be set`
      );
    }
  }

  /**
   * Derive the RDN value of a new entry when the schema says the server
   * generates it — an account identifier taken from the local part of its mail
   * address, typically.
   *
   * The derivation itself (source attribute, extraction pattern, collision
   * strategy) is schema configuration; this method only applies it.
   *
   * @param body creation payload
   * @returns the generated value, or undefined when nothing is generated
   * @throws BadRequestError when the source attribute is missing, or when the
   *         value collides and the schema asks for an error
   */
  protected async generateMainAttribute(
    body: Record<string, AttributeValue>
  ): Promise<string | undefined> {
    const attr = this.schema?.attributes[this.mainAttribute];
    const rule = attr?.generatedFrom;
    if (!rule) return undefined;

    const raw = body[rule.attribute];
    const source = Array.isArray(raw) ? raw[0] : raw;
    if (source === undefined || source === null || source === '') {
      throw new BadRequestError(
        `Attribute "${rule.attribute}" is required to generate "${this.mainAttribute}"`
      );
    }
    let value = String(source);
    if (rule.extract) {
      const match = getCompiledRegex(rule.extract).exec(value);
      if (match) value = match[1] !== undefined ? match[1] : match[0];
    }
    if (rule.lowercase) value = value.toLowerCase();
    // The source charset is rarely the target's. A mail local part may legally
    // carry `+`, `'` or `!` — the shipped mail test admits them — while a
    // `uid` may not, and the derived value is validated against the `uid`
    // rule. Without a way to say which characters to drop, `john+tag@…` was
    // refused for an attribute the client is forbidden to send, so no request
    // could ever succeed.
    if (rule.strip)
      value = value.replace(getCompiledRegex(rule.strip, 'g'), '');
    if (!value) {
      throw new BadRequestError(
        `Cannot generate "${this.mainAttribute}" from "${rule.attribute}"`
      );
    }

    // The generated value becomes the RDN, so a collision is a duplicate DN.
    // The source of the identifier is rarely unique on its own: two mail
    // domains give `jean.dupont@a.example` and `jean.dupont@b.example` the
    // same local part.
    if (!(await this.rdnExists(value))) return value;
    if (rule.onCollision !== 'suffix') {
      throw new ConflictError(
        `${this.singularName} "${value}" already exists (generated from ${rule.attribute})`
      );
    }
    for (let n = 2; n < 1000; n++) {
      const candidate = `${value}-${n}`;
      if (!(await this.rdnExists(candidate))) return candidate;
    }
    throw new ConflictError(
      `Cannot generate a free "${this.mainAttribute}" from "${rule.attribute}"`
    );
  }

  /**
   * Tell whether an entry already uses this RDN value in the branch.
   *
   * @param value candidate RDN value
   * @returns true when the DN is taken
   */
  protected async rdnExists(value: string): Promise<boolean> {
    try {
      const res = (await this.ldap.search(
        { paged: false, scope: 'base' },
        `${this.mainAttribute}=${escapeDnValue(value)},${this.base}`
      )) as SearchResult;
      return (res?.searchEntries?.length ?? 0) > 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // A missing entry is reported as an error by the directory (code 32);
      // any other failure would resurface on the add itself.
      return false;
    }
  }

  /**
   * Build the rejection message for a value that failed its schema `test`.
   *
   * When the schema carries a `hint`, the message says what a valid value
   * looks like instead of only that this one was not. The hint lives next to
   * the pattern so the two cannot drift apart, and so a client can show it
   * under the field *before* the user gets it wrong.
   *
   * @param field attribute name
   * @returns message for a `BadRequestError`
   */
  protected invalidValueMessage(field: string): string {
    const attr = this.schema?.attributes[field];
    const hint = attr?.hint || attr?.items?.hint;
    return hint
      ? `Invalid value for attribute "${field}": ${hint}`
      : `Invalid value for attribute "${field}"`;
  }

  /**
   * API routes
   */
  api(app: Express): void {
    /**
     * @openapi
     * summary: List entries
     * description: |
     *   Returns all entries in the flat LDAP branch, keyed by their
     *   `mainAttribute` value (e.g. `uid` for users). The optional
     *   `match` and `attribute` query parameters filter results using
     *   a substring LDAP search (`attribute=*match*`). `attribute` accepts
     *   several names separated by commas, and the clauses are then joined
     *   with `|`. The `attributes`
     *   parameter limits which LDAP attributes are returned.
     * tags:
     *   - Entities
     * parameters:
     *   - in: path
     *     name: resource
     *     required: true
     *     schema: { type: string }
     *     description: |
     *       Plural name of the flat resource (e.g. `users`, `mailgroups`).
     *       Each concrete plugin sets its own value.
     *     example: users
     *   - in: query
     *     name: match
     *     required: false
     *     schema: { type: string }
     *     description: |
     *       Substring to match. Must be used together with `attribute`.
     *       The resulting LDAP filter is `(attribute=*match*)`, or
     *       `(|(a=*match*)(b=*match*))` when several attributes are named.
     *     example: alice
     *   - in: query
     *     name: attribute
     *     required: false
     *     schema: { type: string }
     *     description: |
     *       LDAP attribute name to match against (used with `match`).
     *       Several may be given, separated by commas; an entry matching any
     *       of them is returned. Each name must be indexed for a substring
     *       search, or the directory scans the branch.
     *     example: cn
     *   - in: query
     *     name: attributes
     *     required: false
     *     schema: { type: string }
     *     description: |
     *       Comma-separated list of LDAP attributes to include in each
     *       returned entry. Omit to return all attributes.
     *     example: uid,cn,mail
     * responses:
     *   '200':
     *     description: Map of entries keyed by mainAttribute value.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/FlatList' }
     *         example:
     *           alice:
     *             dn: uid=alice,ou=users,dc=example,dc=com
     *             uid: alice
     *             cn: Alice Smith
     *             mail: alice@example.com
     *           bob:
     *             dn: uid=bob,ou=users,dc=example,dc=com
     *             uid: bob
     *             cn: Bob Jones
     *             mail: bob@example.com
     *   '400':
     *     description: Invalid LDAP attribute name in `attribute` parameter.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
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
          args.filter = substringSearchFilter(
            req.query.match,
            req.query.attribute
          );
        }
        if (req.query.attributes && typeof req.query.attributes === 'string') {
          args.attributes = req.query.attributes.split(',');
        }
        const list = await this.listEntries(args);
        res.json(this.projectList(list));
      })
    );

    /**
     * @openapi
     * summary: Get entry by ID or DN
     * description: |
     *   Returns a single entry identified by its `mainAttribute` value
     *   (e.g. a `uid`) or by its full DN. If the value starts with
     *   `mainAttribute=` it is treated as a DN; otherwise it is treated
     *   as a raw RDN value.
     * tags:
     *   - Entities
     * parameters:
     *   - in: path
     *     name: resource
     *     required: true
     *     schema: { type: string }
     *     description: |
     *       Plural name of the flat resource (e.g. `users`, `mailgroups`).
     *       Each concrete plugin sets its own value.
     *     example: users
     * responses:
     *   '200':
     *     description: The requested entry.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/FlatEntry' }
     *         example:
     *           dn: uid=alice,ou=users,dc=example,dc=com
     *           uid: alice
     *           cn: Alice Smith
     *           sn: Smith
     *           mail: alice@example.com
     *   '400':
     *     description: The supplied DN is not a direct child of the configured base.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Entry not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: user not found
     *           code: 404
     */
    // Get entry by id or DN
    app.get(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      asyncHandler(async (req, res) => this.apiGet(req, res))
    );

    /**
     * @openapi
     * summary: Create entry
     * description: |
     *   Creates a new entry in the flat LDAP branch. The `mainAttribute`
     *   field (e.g. `uid`) is required and used to construct the DN.
     *   Returns the newly created entry on success (HTTP 201).
     * tags:
     *   - Entities
     * parameters:
     *   - in: path
     *     name: resource
     *     required: true
     *     schema: { type: string }
     *     description: |
     *       Plural name of the flat resource (e.g. `users`, `mailgroups`).
     *       Each concrete plugin sets its own value.
     *     example: users
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/FlatCreate' }
     *       example:
     *         uid: carol
     *         cn: Carol White
     *         sn: White
     *         mail: carol@example.com
     * responses:
     *   '201':
     *     description: Entry created; returns the new entry.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/FlatEntry' }
     *         example:
     *           dn: uid=carol,ou=users,dc=example,dc=com
     *           uid: carol
     *           cn: Carol White
     *           sn: White
     *           mail: carol@example.com
     *   '400':
     *     description: Missing required field or validation error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '409':
     *     description: Entry already exists.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Add entry
    app.post(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      asyncHandler(async (req, res) => this.apiAdd(req, res))
    );

    /**
     * @openapi
     * summary: Delete entry
     * description: |
     *   Permanently removes the entry identified by `id` from the LDAP
     *   branch. The `id` may be either a `mainAttribute` value or the
     *   entry's full DN.
     * tags:
     *   - Entities
     * parameters:
     *   - in: path
     *     name: resource
     *     required: true
     *     schema: { type: string }
     *     description: |
     *       Plural name of the flat resource (e.g. `users`, `mailgroups`).
     *       Each concrete plugin sets its own value.
     *     example: users
     * responses:
     *   '200':
     *     description: Entry deleted.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '404':
     *     description: Entry not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Delete entry
    app.delete(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      asyncHandler(async (req, res) => this.apiDelete(req, res))
    );

    /**
     * @openapi
     * summary: Modify entry
     * description: |
     *   Applies a partial update to the entry identified by `id`. The
     *   body follows the LDAP modify structure: `add`, `replace`, and/or
     *   `delete` maps. The `mainAttribute` (e.g. `uid`) cannot be
     *   changed through this endpoint.
     * tags:
     *   - Entities
     * parameters:
     *   - in: path
     *     name: resource
     *     required: true
     *     schema: { type: string }
     *     description: |
     *       Plural name of the flat resource (e.g. `users`, `mailgroups`).
     *       Each concrete plugin sets its own value.
     *     example: users
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/FlatModify' }
     *       example:
     *         replace:
     *           mail: alice.smith@example.com
     *           cn: Alice M. Smith
     * responses:
     *   '200':
     *     description: Entry updated.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '400':
     *     description: Validation error or attempt to modify a fixed attribute.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Entry not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Modify entry
    app.put(
      `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      asyncHandler(async (req, res) => this.apiModify(req, res))
    );

    /**
     * @openapi
     * summary: Move entry to another organisation
     * description: |
     *   Moves the entry to a different organisational unit by updating
     *   the configured department-link and department-path attributes
     *   (`ldap_organization_link_attribute` and
     *   `ldap_organization_path_attribute`). The plugin's schema must
     *   declare both attributes; otherwise the request is rejected with
     *   400.
     * tags:
     *   - Entities
     * parameters:
     *   - in: path
     *     name: resource
     *     required: true
     *     schema: { type: string }
     *     description: |
     *       Plural name of the flat resource (e.g. `users`, `mailgroups`).
     *       Each concrete plugin sets its own value.
     *     example: users
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema: { $ref: '#/components/schemas/FlatMoveRequest' }
     *       example:
     *         targetOrgDn: ou=engineering,ou=departments,dc=example,dc=com
     * responses:
     *   '200':
     *     description: Entry moved; returns the new department path and link.
     *     content:
     *       application/json:
     *         example:
     *           success: true
     *           departmentPath: /engineering
     *           departmentLink: ou=engineering,ou=departments,dc=example,dc=com
     *   '400':
     *     description: |
     *       Missing or invalid `targetOrgDn`, or schema does not support
     *       the move operation.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Entry or target organisation not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
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
      const dn = this.resolveDn(id);
      const result = (await this.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
      if (result.searchEntries.length === 0) {
        throw new NotFoundError(`${this.singularName} not found`);
      }
      res.json(this.project(result.searchEntries[0]));
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
    // When the schema says the server derives the identifier, the client is
    // not expected — nor allowed — to send it.
    const generatesId = Boolean(
      this.schema?.attributes[this.mainAttribute]?.generatedFrom
    );
    const body = (
      generatesId ? jsonBody(req, res) : jsonBody(req, res, this.mainAttribute)
    ) as Record<string, AttributeValue> | false;
    if (!body) return;

    this.rejectForbiddenInput(Object.keys(body));

    const id = generatesId
      ? ((await this.generateMainAttribute(body)) as string)
      : (body[this.mainAttribute] as string);
    const additional = { ...body };
    delete additional[this.mainAttribute];
    // Remove dn if provided - it will be constructed by addEntry
    delete additional.dn;

    await this.addEntry(id, additional, req);
    const entry = await this.searchEntriesByName(id, false);
    return created(res, this.project(entry[id]));
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const id = decodeURIComponent(req.params.id as string);
    await tryMethod(res, this.deleteEntry.bind(this), id);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as ModifyRequest | false;
    if (!body) return;
    this.rejectForbiddenInput([
      ...Object.keys(body.add || {}),
      ...Object.keys(body.replace || {}),
      ...(Array.isArray(body.delete)
        ? body.delete
        : Object.keys(body.delete || {})),
    ]);
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

  /**
   * Resolve an id (either an RDN value or a full DN) into a DN inside this
   * instance's base branch.
   *
   * A value is treated as a full DN only when it starts with
   * `mainAttribute=`; otherwise it is treated as a raw RDN value and escaped.
   * This matters for cn-based branches where values like `Smith, John` are
   * legal and must not be misclassified as DNs.
   *
   * When the id is a full DN we enforce that its parent equals this.base
   * (LdapFlat entries are, by definition, direct children of the base).
   * The comparison is done on the parsed RDN components so escape-aware
   * payloads like `cn=pwn\,ou=titles,ou=nomenclature,dc=example,dc=com`
   * cannot sneak past a naive textual suffix check: `\,` is a literal comma
   * inside the first RDN's value, so the actual parent of that DN is
   * `ou=nomenclature,dc=example,dc=com` — one level above the expected base.
   *
   * @throws BadRequestError if the provided DN is not a direct child of this.base
   */
  protected resolveDn(id: string): string {
    const dnPrefix = new RegExp(`^${escapeRegex(this.mainAttribute)}=`, 'i');
    if (dnPrefix.test(id)) {
      const parent = getParentDn(id);
      // If the DN has a single RDN, getParentDn returns the DN itself; treat
      // that as "missing parent" rather than "parent equals base".
      const hasParent = parent !== id;
      if (!hasParent || parent.toLowerCase() !== this.base.toLowerCase()) {
        throw new BadRequestError(
          `DN must be a direct child of "${this.base}". ` +
            `Provided DN "${id}" has parent "${hasParent ? parent : '<none>'}"`
        );
      }
      return id;
    }
    return `${this.mainAttribute}=${escapeDnValue(id)},${this.base}`;
  }

  async addEntry(
    id: string,
    additional: AttributesList = {},
    req?: Request
  ): Promise<boolean> {
    let dn: string;
    if (new RegExp(`^${this.mainAttribute}=`, 'i').test(id)) {
      // DN provided - validate it's in the correct flat branch
      dn = this.resolveDn(id);
      // Extract the RDN value, correctly handling escaped commas
      // e.g. uid=Smith\,John,ou=users -> id = "Smith\,John"
      id = id.replace(
        new RegExp(`^${this.mainAttribute}=((?:\\\\.|[^,])+)(?:,.*)?$`, 'i'),
        '$1'
      );
    } else {
      validateDnValue(id, this.mainAttribute);
      dn = this.resolveDn(id);
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
      // A business rule that refused the entry already said what happened and
      // with which status; wrapping it would turn a 409 "this address is
      // already used" into an opaque 500. A refusal is also an ordinary
      // outcome, not an incident, so it is not logged as one.
      const refusal = err instanceof HttpError && err.statusCode < 500;
      this.logger[refusal ? 'debug' : 'error']('LDAP add failed:', {
        dn,
        entry: JSON.stringify(entry, null, 2),
        error: err,
      });
      if (err instanceof HttpError) throw err;
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
    let dn = this.resolveDn(id);
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
    if (!/,/.test(id)) {
      validateDnValue(id, this.mainAttribute);
    }
    if (!/,/.test(newId)) {
      validateDnValue(newId, this.mainAttribute);
    }
    let dn = this.resolveDn(id);
    let newDn = this.resolveDn(newId);
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
    let dn = this.resolveDn(id);
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
    const dn = this.resolveDn(id);

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
      // Let a NotFoundError we raised ourselves - or an LDAP NoSuchObjectError
      // (code 32) - travel out as a NotFoundError instead of being wrapped
      // into a generic 500.
      if (err instanceof NotFoundError) {
        throw err;
      }
      if ((err as { code?: number }).code === 32) {
        throw new NotFoundError(`Organization ${orgDn} not found`);
      }
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
    // `apiAdd` re-reads the entry it has just written through this, so an
    // identifier the schema admits has to survive the trip: the shipped
    // position and group schemas accept `( )` and `*`, which a raw
    // interpolation turns into an unparseable filter — after the entry is
    // committed, so the caller saw a 500 on a creation that had succeeded.
    // A partial search means the value to look for, not a pattern to run.
    const escaped = escapeLdapFilter(name);
    const filter = partial
      ? `(${this.mainAttribute}=*${escaped}*)`
      : `(${this.mainAttribute}=${escaped})`;
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
        throw new BadRequestError(this.invalidValueMessage(field));
      }
      if (attr.required && !value && !attr.generated) {
        throw new BadRequestError(`Attribute "${field}" is required`);
      }
    }
    // Check required fields, granting a `generated` attribute the exemption
    // only when something will honour it. See `missingRequiredAttribute`.
    const missing = missingRequiredAttribute(
      this.schema,
      entry,
      this.server.loadedPlugins
    );
    if (missing)
      throw new BadRequestError(`Attribute "${missing}" is required`);
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
          throw new BadRequestError(this.invalidValueMessage(field));
        }
      }
    }
    if (changes.replace) {
      for (const [field, value] of Object.entries(changes.replace)) {
        checkFixed(field, value);
        if (!(await this._validateOneChange(field, value))) {
          throw new BadRequestError(this.invalidValueMessage(field));
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

      // Check branch restriction if provided. Asked RDN by RDN: a suffix
      // match with an optional comma reads `uid=x,xou=users,dc=example,dc=com`
      // as being inside `ou=users,dc=example,dc=com`, so a pointer could name
      // an entry of a branch the schema never allowed.
      if (attr.branch && attr.branch.length > 0) {
        const isInBranch = attr.branch.some(branch =>
          isDnInBranch(dnValue, branch)
        );
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

    // An array declares the rules of its *elements* under `items`, which is
    // where the shipped schemas put them — `mailAlternateAddress` has carried
    // `items.test` since v0.7.0 and `twakeDelegatedUsers` an `items.branch`.
    // Neither was read here, so the flat routes accepted anything in them
    // while the console's form refused it client-side and `groups` refused
    // `items.test` server-side. The rule is the same rule; it applies here
    // too.
    if (attr.items?.branch?.length) {
      for (const dnValue of asList(value)) {
        // Same rule as a pointer's own branch, and asked the same way.
        const isInBranch = attr.items.branch.some(branch =>
          isDnInBranch(dnValue, branch)
        );
        if (!isInBranch)
          throw new BadRequestError(
            `Field ${field} must point to a DN within allowed branches: ${attr.items.branch.join(', ')}`
          );
      }
    }

    const pattern = attr.test ?? attr.items?.test;
    if (pattern) {
      const regex =
        typeof pattern === 'string' ? getCompiledRegex(pattern) : pattern;
      return asList(value).every(v => regex.test(v));
    }
    return true;
  }
}
