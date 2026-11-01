/**
 * @module abstract/ldapFlat
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Abstract class to manage LDAP entries in a flat branch
 * - add/delete entries
 * - modify entries
 * - validate with schema
 */
import { Type } from '@sinclair/typebox';
import type { Express, Request, Response } from 'express';

import type { DM } from '../bin';
import type ldapActions from '../lib/ldapActions';
import type {
  AttributesList,
  AttributeValue,
  LdapList,
  ModifyRequest,
  SearchOptions,
  SearchResult,
} from '../lib/ldapActions';
import { assertModifyRequest } from '../lib/ldapActions';
import {
  created,
  jsonBody,
  multiStatus,
  tryMethod,
  WriteResponse,
} from '../lib/expressFormatedResponses';
import {
  escapeDnValue,
  escapeLdapFilter,
  escapeRegex,
  getCompiledRegex,
  getParentDn,
  isDummyMemberDn,
  normalizeDn,
  assertedRdnValue,
  namesByDn,
  substringSearchFilter,
  validateDnValue,
} from '../lib/utils';
import type { Schema } from '../config/schema';
import {
  modifiedAttributeNames,
  toDirectoryEntry,
  neverReturnAttributes,
  assertClientMaySet,
} from '../config/schema';
import {
  applyFixedDefaults,
  EntityValidator,
} from '../lib/entitySchema/validator';
import {
  BadRequestError,
  ConflictError,
  HttpError,
  isAuthzRefusal,
  NotFoundError,
  UnprocessableEntityError,
} from '../lib/errors';
import { extractLdapCode } from '../lib/ldapCodes';
import type { FlatHookBus } from '../lib/hookBus';
import { loadSchemaFile } from '../lib/schemaFile';

import DmPlugin, { defineRoute } from './plugin';

/** RFC 4511 `maxInt`: the most a search request's size limit can say. */
const LDAP_MAX_INT = 2147483647;

/**
 * Entries keyed by their main attribute, up to `limit` distinct identifiers.
 *
 * Counted after the entries without that attribute are dropped, not as the
 * directory counts them: a subtree search returns the branch's own entry
 * too, and it names nothing a client could ask for. When the search named
 * the attribute, ldapts gives such an entry an empty array rather than
 * nothing, so emptiness is read from the first value.
 *
 * @param mainAttribute attribute holding the identifier
 * @param limit how many identifiers to keep, all when absent
 * @returns the map being filled, and `add`, false once an entry past `limit`
 *          was met and left out
 */
function entryCollector(
  mainAttribute: string,
  limit?: number
): { entries: LdapList; add(batch: AttributesList[]): boolean } {
  const entries: LdapList = {};
  const seen = new Set<string>();
  return {
    entries,
    add(batch: AttributesList[]): boolean {
      for (const e of batch) {
        const value = e[mainAttribute];
        const first = Array.isArray(value) ? value[0] : value;
        if (first === undefined || first === null || first === '') continue;
        const id = String(first);
        if (!seen.has(id)) {
          if (limit !== undefined && seen.size >= limit) return false;
          seen.add(id);
        }
        entries[id] = e;
      }
      return true;
    },
  };
}

/** What {@link LdapFlat.listEntries} is asked for. */
export interface ListEntriesOptions {
  /** LDAP filter, every entry of the branch when absent */
  filter?: string;
  /** attributes to return, all when absent */
  attributes?: string[];
  /** incoming request, forwarded to the authorization hooks */
  req?: Request;
  /** keep at most this many entries, all when absent */
  limit?: number;
}

/**
 * What a rename needs from the plugin that knows what references what.
 *
 * Declared here by its shape rather than imported from
 * `plugins/ldap/enterpriseRules`: nothing under `abstract/` depends on a
 * plugin, and a server that does not load the rules must still be able to
 * rename — it just renames without a cascade, which is what
 * {@link DmPlugin.requirePlugin} answers.
 *
 * The references themselves are opaque: they are found on one side and handed
 * back on the other, and this class has no business reading them.
 */
interface ReferenceRewriter extends DmPlugin {
  /** Every reference the directory holds to an entry, before it is renamed */
  findReferences(dn: string): Promise<unknown[]>;
  /** Point them all at the new DN, collecting what could not be written */
  rewriteReferences(
    references: unknown[],
    oldDn: string,
    newDn: string,
    req?: Request
  ): Promise<{
    updated: number;
    failed: { attribute: string; count: number }[];
  }>;
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
 * FlatRenameRequest:
 *   type: object
 *   description: |
 *     Body for changing the identifier of an entry. The field is named
 *     `newId` for every resource, whatever that resource calls its
 *     `mainAttribute`.
 *   required: [newId]
 *   properties:
 *     newId:
 *       type: string
 *       description: |
 *         New value of the resource's `mainAttribute`. A value, not a DN.
 *       example: bob
 *   example:
 *     newId: bob
 * FlatRenameResult:
 *   type: object
 *   description: |
 *     Outcome of a rename: the entry's new DN, and how many references to
 *     the old one were rewritten.
 *   properties:
 *     success:
 *       type: boolean
 *       description: False when a reference could not be rewritten.
 *     dn:
 *       type: string
 *       description: DN the entry now has.
 *     referencesUpdated:
 *       type: integer
 *       description: References rewritten to the new DN.
 *     referencesFailed:
 *       type: array
 *       description: |
 *         References left naming the old DN, counted per attribute. The
 *         referring entries are named in the server log, not here.
 *       items:
 *         type: object
 *         properties:
 *           attribute: { type: string }
 *           count: { type: integer }
 *   example:
 *     success: true
 *     dn: uid=bob,ou=users,dc=example,dc=com
 *     referencesUpdated: 3
 */
export const FlatListQuery = Type.Object({
  match: Type.Optional(Type.String()),
  attribute: Type.Optional(Type.String()),
  attributes: Type.Optional(Type.String()),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  ),
});

export const FlatEntryParams = Type.Object({
  id: Type.String({ minLength: 1 }),
});

export const FlatMoveBody = Type.Object({
  targetOrgDn: Type.String({ minLength: 1 }),
});

export const FlatMoveResponse = Type.Object({
  success: Type.Boolean(),
  departmentPath: Type.String(),
  departmentLink: Type.String(),
});

export const FlatRenameBody = Type.Object({
  newId: Type.String({ minLength: 1 }),
});

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
  /** `hookBus`, raising this entity's own hooks */
  private readonly ownHooks: FlatHookBus;

  /**
   * @param server the server
   * @param config the entity, its hook prefix included
   */
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
    // Built here, where a subclass can name its prefix: one set at
    // construction would be too late for a class field
    this.ownHooks = this.hookBus.prefixed(this.hookPrefix);

    if (!this.base) {
      throw new Error(`LDAP base is not defined for ${this.singularName}`);
    }
    this.ldap.declareObjectClasses(this.base, this.objectClass);

    if (config.schemaPath) {
      try {
        this.schema = loadSchemaFile<Schema>(config.schemaPath, {
          config: this.config,
        });
        this.ldap.knowAttributeNames(Object.keys(this.schema.attributes));
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
   * Attributes never sent back over the API. A manager may reset a password
   * without being able to read it back: the asymmetry is a projection, not an
   * authorization rule, so it lives with the schema.
   *
   * @returns lowercased attribute names
   */
  protected hiddenAttributes(): Set<string> {
    return neverReturnAttributes([this.schema]);
  }

  /**
   * Attributes to ask for when reading one entry. `*` brings the user
   * attributes only: an operational one the schema declares, such as
   * `memberOf`, comes back only when named. A name the directory does not
   * define is ignored by it.
   *
   * @returns attribute list
   */
  protected entryAttributes(): string[] {
    return ['*', ...Object.keys(this.schema?.attributes ?? {})];
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
    assertClientMaySet(this.schema, names, this.mainAttribute);
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
    const value = this.deriveMainAttribute(body);
    const rule = this.schema?.attributes[this.mainAttribute]?.generatedFrom;
    if (value === undefined || !rule) return undefined;

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
   * The identifier the schema derives from a creation body, before any
   * collision is looked for: no directory read, so a creation can be judged
   * on it before the branch is searched.
   *
   * @param body creation body
   * @returns the derived value, or undefined when the schema derives none
   */
  protected deriveMainAttribute(
    body: Record<string, AttributeValue>
  ): string | undefined {
    const attr = this.schema?.attributes[this.mainAttribute];
    const rule = attr?.generatedFrom;
    // `generated` is the switch, `generatedFrom` only the recipe: an operator
    // told to drop the marker to take the value from the client gets exactly
    // that, rather than the derived value silently replacing the one sent.
    if (!rule || !attr.generated) return undefined;

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
    return value;
  }

  /**
   * The entry `addEntry` writes for an identifier, as the plugin's own hooks
   * receive it. Built in one place, so that the creation judged first is the
   * creation made: a default attribute missing from one of two copies — an
   * organization link among them — judged another branch than the one
   * written to.
   *
   * @param id identifier
   * @param additional attributes sent
   * @returns the entry
   */
  protected candidateEntry(
    id: string,
    additional: AttributesList
  ): AttributesList {
    // Whatever was sent: the classes are the entity's
    const entry: AttributesList = {
      ...this.defaultAttributes,
      [this.mainAttribute]: id,
      ...additional,
      objectClass: this.objectClass,
    };
    applyFixedDefaults(this.schema, entry);
    return entry;
  }

  /**
   * Tell whether an entry already uses this RDN value in the branch.
   *
   * Asked as the server, not as the caller. A uniqueness check has to see
   * the whole branch to answer at all: a caller who cannot read
   * `uid=jdoe` must not be handed `jdoe` as a free identifier, which is
   * what a request-bound read would answer. What it can leak is bounded by
   * the same reasoning — whether a name is taken, through the identifier
   * the server then generates.
   *
   * @param value candidate RDN value
   * @returns true when the DN is taken
   */
  protected async rdnExists(value: string): Promise<boolean> {
    try {
      const res = (await this.ldap.system.search(
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

  /** The schema's rules; the pointer lookups run as the server */
  protected validator(): EntityValidator {
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
      singularName: this.singularName,
    });
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
     *
     *   Without `limit`, the answer holds every match or fails: a directory
     *   whose size limit is below the number of matches makes it a `422`.
     *   With `limit`, at most that many entries come back, and the
     *   `X-Result-Truncated: true` header says others were left out.
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
     *       returned entry. Omit to return all attributes. The
     *       `mainAttribute` is always returned: it keys the map.
     *     example: uid,cn,mail
     *   - in: query
     *     name: limit
     *     required: false
     *     schema: { type: integer, minimum: 1 }
     *     description: |
     *       Return at most this many entries. When more match, the response
     *       carries `X-Result-Truncated: true`. It also does when the
     *       directory refused to list every match, even if fewer than
     *       `limit` came back: the directory does not say whether it cut
     *       that answer short.
     *     example: 50
     * responses:
     *   '200':
     *     description: Map of entries keyed by mainAttribute value.
     *     headers:
     *       X-Result-Truncated:
     *         description: |
     *           `true` when `limit` was given and the answer may not hold
     *           every match (see `limit`). Absent otherwise.
     *         schema: { type: string, enum: ['true'] }
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
     *     description: |
     *       Invalid LDAP attribute name in `attribute` parameter, or `limit`
     *       is not a positive integer.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '422':
     *     description: |
     *       No `limit` was given and more entries match than the directory
     *       will list in one answer (LDAP `sizeLimitExceeded`).
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: "Too many entries to list at once: the directory's size limit was exceeded. Narrow the search, or pass `limit`."
     */
    // List entries
    defineRoute(app, {
      method: 'get',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      query: FlatListQuery,
      handler: async ({ req, res, query }) => {
        const args: { filter?: string; attributes?: string[] } = {};
        if (query.match && query.attribute) {
          args.filter = substringSearchFilter(query.match, query.attribute);
        }
        if (query.attributes) args.attributes = query.attributes.split(',');
        const limit = query.limit;

        let listed: { entries: LdapList; truncated: boolean };
        try {
          listed = await this.listEntriesLimited({ ...args, limit, req });
        } catch (err) {
          // The directory's refusal to list that many, which the caller can
          // do something about; not a fault of the server. With `limit`, the
          // listing answers a refusal itself.
          if (limit !== undefined || extractLdapCode(err) !== 4) throw err;
          throw new UnprocessableEntityError(
            "Too many entries to list at once: the directory's size limit " +
              'was exceeded. Narrow the search, or pass `limit`.'
          );
        }
        if (listed.truncated) res.set('X-Result-Truncated', 'true');
        res.json(this.projectList(listed.entries));
      },
    });

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
     */
    // Get entry by id or DN
    defineRoute(app, {
      method: 'get',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      params: FlatEntryParams,
      handler: async ({ req, res }) => this.apiGet(req, res),
    });

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
    defineRoute(app, {
      method: 'post',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}`,
      handler: async ({ req, res }) => this.apiAdd(req, res),
    });

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
    defineRoute(app, {
      method: 'delete',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      params: FlatEntryParams,
      responses: { 200: WriteResponse },
      handler: async ({ req, res }) => this.apiDelete(req, res),
    });

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
    defineRoute(app, {
      method: 'put',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id`,
      params: FlatEntryParams,
      responses: { 200: WriteResponse },
      handler: async ({ req, res }) => this.apiModify(req, res),
    });

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
    defineRoute(app, {
      method: 'post',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id/move`,
      params: FlatEntryParams,
      body: FlatMoveBody,
      responses: { 200: FlatMoveResponse },
      handler: async ({ req, res }) => this.apiMove(req, res),
    });

    /**
     * @openapi
     * summary: Rename entry (change its identifier)
     * description: |
     *   Changes the `mainAttribute` value of the entry — its RDN, and so its
     *   DN — and rewrites the references other entries hold to the old DN:
     *   group memberships and ownerships, delegations, managers, every
     *   pointer a loaded schema declares towards this branch. The rewrite is
     *   finished when the call returns.
     *
     *   The body field is `newId` for every resource, whatever that resource
     *   calls its `mainAttribute`, and it carries a value, not a DN.
     *
     *   The new value is held to the same `test` as a creation would hold it
     *   to, and refused when the identifier is already taken in this branch.
     *   A `unique` constraint the schema widens to other branches is **not**
     *   applied here: it is enforced from the add and modify hooks, while
     *   what a rename needs is the RDN's own branch — which is the namespace
     *   the directory itself enforces.
     *
     *   Re-issuing the same rename is a repair, not an error: when the entry
     *   already carries the new identifier, the reference rewrite runs alone.
     *   That is how a `207` is finished off.
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
     *       schema: { $ref: '#/components/schemas/FlatRenameRequest' }
     *       example:
     *         newId: bob
     * responses:
     *   '200':
     *     description: Entry renamed and every reference rewritten.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/FlatRenameResult' }
     *         example:
     *           success: true
     *           dn: uid=bob,ou=users,dc=example,dc=com
     *           referencesUpdated: 3
     *   '207':
     *     description: |
     *       Entry renamed, but at least one reference could not be
     *       rewritten. The rename is done and is not rolled back; re-issue
     *       the same request to finish the rewrite.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/FlatRenameResult' }
     *         example:
     *           success: false
     *           dn: uid=bob,ou=users,dc=example,dc=com
     *           referencesUpdated: 1
     *           referencesFailed:
     *             - attribute: member
     *               count: 2
     *   '400':
     *     description: |
     *       Missing or invalid `newId`, a value the schema refuses, or an
     *       attribute sent beside it.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '403':
     *     description: No write permission on the branch.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Entry not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '409':
     *     description: The identifier is already taken.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Rename entry (change its identifier)
    defineRoute(app, {
      method: 'post',
      path: `${this.config.api_prefix}/v1/ldap/${this.pluralName}/:id/rename`,
      params: FlatEntryParams,
      body: FlatRenameBody,
      handler: async ({ req, res }) => this.apiRename(req, res),
    });
  }

  async apiGet(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    try {
      const dn = this.resolveDn(id);
      const result = (await this.ldap.search(
        { paged: false, scope: 'base', attributes: this.entryAttributes() },
        dn,
        req
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
    const idAttr = this.schema?.attributes[this.mainAttribute];
    const generatesId = Boolean(idAttr?.generated && idAttr.generatedFrom);
    const body = (
      generatesId ? jsonBody(req, res) : jsonBody(req, res, this.mainAttribute)
    ) as Record<string, AttributeValue> | false;
    if (!body) return;

    this.rejectForbiddenInput(Object.keys(body));

    const additional = { ...body };
    delete additional[this.mainAttribute];
    // Remove dn if provided - it will be constructed by addEntry
    delete additional.dn;
    // Judged before the branch is searched for a collision: whether the
    // derived name is taken is not for a caller who may not create here. A
    // suffix added on a collision keeps the entry in the same branch.
    const derived = generatesId ? this.deriveMainAttribute(body) : undefined;
    if (derived !== undefined)
      await this.ldap.authorize('ldapaddrequest', [
        this.resolveDn(derived),
        this.candidateEntry(derived, additional),
        req,
      ]);
    const id = generatesId
      ? ((await this.generateMainAttribute(body)) as string)
      : (body[this.mainAttribute] as string);

    await this.addEntry(id, additional, req);
    // As the server: the identifier the caller just wrote is answered back
    // to them, whether or not they may read the branch it went to — that
    // only. By its DN: the name may be another entry's elsewhere, and read
    // from `creationOf` as the write read it, so a spelling the directory
    // folds differently is not answered from another DN.
    const written = (await this.ldap.system.search(
      { paged: false, scope: 'base', attributes: [this.mainAttribute] },
      this.creationOf(id).dn
    )) as SearchResult;
    return created(res, this.project(written.searchEntries[0]));
  }

  async apiDelete(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    await tryMethod(res, this.deleteEntry.bind(this), id, req);
  }

  async apiModify(req: Request, res: Response): Promise<void> {
    const body = jsonBody(req, res) as ModifyRequest | false;
    if (!body) return;
    assertModifyRequest(body);
    this.rejectForbiddenInput(modifiedAttributeNames(body));
    const id = req.params.id as string;
    await tryMethod(res, this.modifyEntry.bind(this), id, body, req);
  }

  async apiMove(req: Request, res: Response): Promise<void> {
    const body = req.body as { targetOrgDn: string };
    const id = req.params.id as string;
    const { targetOrgDn } = body;

    const result = await this.moveEntry(id, targetOrgDn, req);
    res.json({
      success: true,
      ...result,
    });
  }

  /**
   * Change an entry's identifier, and make the directory consistent again
   * before answering.
   *
   * Shaped like `apiMove`, and deliberately not on `tryMethod`: that helper
   * flattens every outcome to `{success: true}`, which cannot say how many
   * references were rewritten nor that one was not.
   *
   * @param req request, carrying `newId`
   * @param res response
   */
  async apiRename(req: Request, res: Response): Promise<void> {
    const body = req.body as Record<string, unknown> & { newId: string };
    const newId = body.newId;

    // Everything else in the body is an attribute name, and one the client is
    // not allowed to set is refused here as it is on a creation — a caller
    // that slips `twakeDepartmentPath` in beside `newId` is told so instead of
    // seeing it ignored. `newId` itself is this endpoint's parameter, not an
    // attribute name, exactly as `/move`'s `targetOrgDn` is: see the
    // `generated` marker.
    this.rejectForbiddenInput(Object.keys(body).filter(key => key !== 'newId'));

    // A value, not a DN. `resolveDn` accepts either, so without this the field
    // would quietly take two kinds of input where it documents one.
    if (new RegExp(`^${escapeRegex(this.mainAttribute)}=`, 'i').test(newId)) {
      throw new BadRequestError(
        `newId must be a ${this.mainAttribute} value, not a DN`
      );
    }
    try {
      validateDnValue(newId, this.mainAttribute);
    } catch (err) {
      // `validateDnValue` throws a plain Error — an empty or control-character
      // identifier came back as a 500 on a request that was simply wrong.
      throw new BadRequestError(
        err instanceof Error ? err.message : 'Invalid newId'
      );
    }
    // The schema's own rule, the one a creation applies
    await this.validator().validateValue(this.mainAttribute, newId);

    const id = req.params.id as string;
    const dn = this.resolveDn(id);
    const newDn = this.resolveDn(newId);

    // The placeholder some directories keep to satisfy `groupOfNames` is a
    // configuration value, not an entry: renaming it — or onto it — would
    // leave `isDummyMemberDn` naming something else, and every empty group
    // would then refuse to be deleted by `deleteGuard: nonEmpty`.
    const dummy = this.config.group_dummy_user;
    if (
      dummy &&
      (isDummyMemberDn(dn, dummy) || isDummyMemberDn(newDn, dummy))
    ) {
      throw new ConflictError(
        `${dummy} is the configured placeholder member and cannot be renamed`
      );
    }

    // Before looking for either entry: whether they are there is not for a
    // caller who may not rename here
    await this.ldap.authorize('ldaprenamerequest', [dn, newDn, req]);
    const sameName = normalizeDn(dn) === normalizeDn(newDn);
    const source = await this.entryExists(dn);
    const target = sameName ? source : await this.entryExists(newDn);

    const rules = this.requirePlugin<ReferenceRewriter>('ldapEnterpriseRules');
    let references: unknown[] = [];

    if (sameName) {
      // Re-issuing a rename that already happened. Nothing to rename, and
      // nothing to rewrite either: the references were rewritten to this very
      // DN. Answering 200 is what makes a retry safe.
      if (!source) throw new NotFoundError(`${this.singularName} not found`);
    } else if (source) {
      if (target) {
        throw new ConflictError(
          `${this.singularName} "${newId}" already exists`
        );
      }
      // Asked while the old DN is still live: afterwards nothing answers for
      // it, and the entries left pointing at it could only be found by walking
      // the whole directory.
      references = (await rules?.findReferences(dn)) || [];
      // The commit point. Everything above can still refuse; nothing below
      // can put this back, and a failure here leaves the directory untouched,
      // so the directory's own status is what the caller gets.
      await this.renameEntry(dn, newDn, req);
    } else if (target) {
      // The old DN is gone and the new one is there: the rename happened and
      // the rewrite did not finish — a 207, or a crash between the two. Same
      // request, and it becomes the repair.
      references = (await rules?.findReferences(dn)) || [];
    } else {
      throw new NotFoundError(`${this.singularName} not found`);
    }

    const report =
      rules && references.length > 0
        ? await rules.rewriteReferences(references, dn, newDn, req)
        : { updated: 0, failed: [] as { attribute: string; count: number }[] };

    const answer = {
      success: report.failed.length === 0,
      dn: newDn,
      referencesUpdated: report.updated,
    };
    if (report.failed.length === 0) {
      res.json(answer);
      return;
    }
    // The rename is a fact; hiding it behind an error would describe a
    // directory that does not exist.
    multiStatus(res, { ...answer, referencesFailed: report.failed });
  }

  /**
   * Whether an entry exists, asked without narrowing by the caller's own
   * permissions — as `apiGet` asks it.
   *
   * @param dn entry to look for
   * @returns true when the directory holds it
   */
  private async entryExists(dn: string): Promise<boolean> {
    try {
      // As the server: the question is whether the directory holds it, and
      // the caller's right to read it is settled by the authorization hooks
      // on the rename itself.
      const result = (await this.ldap.system.search(
        { paged: false, scope: 'base', attributes: ['dn'] },
        dn
      )) as SearchResult;
      return (result?.searchEntries?.length ?? 0) > 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // A missing entry is reported as an error by the directory (code 32).
      return false;
    }
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
    // The same test as `namesByDn`, which decides in `addEntry` whether the
    // identifier is a DN: two readers disagreeing on one input would read it
    // as a DN there and as a bare name here
    if (namesByDn(id, this.mainAttribute)) {
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

  /**
   * The name and the DN a creation of `id` gives: `id` is the naming value,
   * or a DN whose first RDN names the entry, folded as the directory folds
   * it and written back in this branch.
   *
   * Both the write and the answer it gets after it read the DN here, so a
   * spelling the directory folds differently cannot leave the entry created
   * under one DN and read back at another.
   */
  protected creationOf(id: string): { name: string; dn: string } {
    if (!namesByDn(id, this.mainAttribute))
      return { name: id, dn: this.resolveDn(id) };
    // `resolveDn` refuses a DN under another branch with the message that
    // names it; the RDN is then rebuilt here, in this branch
    this.resolveDn(id);
    const name = assertedRdnValue(id, this.mainAttribute, this.base);
    if (name === null)
      throw new BadRequestError(
        `${this.mainAttribute} must be a value, or a "${this.mainAttribute}=…,${this.base}" DN`
      );
    return {
      name,
      dn: `${this.mainAttribute}=${escapeDnValue(name)},${this.base}`,
    };
  }

  async addEntry(
    id: string,
    additional: AttributesList = {},
    req?: Request
  ): Promise<boolean> {
    if (typeof id !== 'string')
      throw new BadRequestError(`${this.mainAttribute} must be a string`);
    // Checked below under the names the write will give them
    await this.ldap.canonicalAttributes(additional);
    const creation = this.creationOf(id);
    id = creation.name;
    let dn = creation.dn;
    try {
      validateDnValue(id, this.mainAttribute);
    } catch (err) {
      // `validateDnValue` throws a plain Error: without this, a name the
      // directory cannot take came back as a 500 on a wrong request
      throw new BadRequestError(
        err instanceof Error ? err.message : 'Invalid identifier'
      );
    }
    let entry = this.candidateEntry(id, additional);
    // Before the checks reading the directory: a pointer leading nowhere, a
    // value already taken, are not for a caller who may not create here
    await this.ldap.authorize('ldapaddrequest', [dn, { ...entry }, req]);
    const candidate = await this.validateNewEntry(dn, {
      [this.mainAttribute]: id,
      ...additional,
      objectClass: this.objectClass,
    });
    // Written from what validation left: a spread cannot remove a key the
    // validator dropped. The defaults are built without the request, so one
    // under a dropped name is kept, as for a key left out
    entry = { ...this.candidateEntry(id, {}), ...candidate };
    toDirectoryEntry(this.schema, entry);

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

    [dn, entry] = await this.ownHooks.chain('add', [dn, entry]);

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
      // `ldapActions.add` already turned entryAlreadyExists into a
      // `ConflictError`, for every creation route at once, so a duplicate
      // arrives here as a refusal like any other.
      if (err instanceof HttpError || isAuthzRefusal(err)) throw err;
      throw new Error(
        `Failed to add ${this.singularName} ${dn}: ${String(err)}`,
        { cause: err }
      );
    }
    this.ownHooks.notify('adddone', dn, entry);
    return res;
  }

  async modifyEntry(
    id: string,
    changes: ModifyRequest,
    req?: Request
  ): Promise<boolean> {
    // `UID` is `uid`, and a fixed attribute deleted as `OBJECTCLASS` is
    // still fixed: the checks below compare names as the write gives them
    await this.ldap.canonicalChanges(changes);
    let dn = this.resolveDn(id);
    const op = this.opNumber();
    [dn, changes] = await this.ownHooks.chain('modify', [dn, changes, op]);
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

    // Before the checks reading the directory, as on a creation
    await this.ldap.authorize('ldapmodifyrequest', [dn, changes, op, req]);
    await this.validateChanges(dn, changes);
    const res = await this.ldap.modify(dn, changes, req);
    this.ownHooks.notify('modifydone', dn, changes, op);
    return res;
  }

  /**
   * Change the RDN of an entry.
   *
   * `ldapActions` hands the request to the `ldaprenamerequest` hook, which
   * the authorization plugins judge by. Without one, the request being
   * served is judged; outside any, nobody judges, as for the startup or
   * scheduled work the optional signature is for.
   *
   * @param id current identifier, or the entry's DN
   * @param newId new identifier, or the entry's new DN
   * @param req request this comes from, so the branch check runs
   * @returns true when the directory accepted the rename
   */
  async renameEntry(
    id: string,
    newId: string,
    req?: Request
  ): Promise<boolean> {
    if (!/,/.test(id)) {
      validateDnValue(id, this.mainAttribute);
    }
    if (!/,/.test(newId)) {
      validateDnValue(newId, this.mainAttribute);
    }
    let dn = this.resolveDn(id);
    let newDn = this.resolveDn(newId);
    [dn, newDn] = await this.ownHooks.chain('rename', [dn, newDn]);
    const res = await this.ldap.rename(dn, newDn, req);
    this.ownHooks.notify('renamedone', dn, newDn);
    return res;
  }

  async deleteEntry(id: string, req?: Request): Promise<boolean> {
    let dn = this.resolveDn(id);
    dn = await this.ownHooks.chain('delete', dn);
    const res = await this.ldap.delete(dn, req);
    this.ownHooks.notify('deletedone', dn);
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
    let currentEntry: SearchResult;
    try {
      currentEntry = (await this.ldap.search(
        { paged: false, scope: 'base', attributes: [linkAttr] },
        dn,
        req
      )) as SearchResult;
    } catch (err) {
      // A base search of a DN that is not there fails with noSuchObject
      if (extractLdapCode(err) === 32)
        throw new NotFoundError(`Entry ${dn} not found`);
      throw err;
    }

    if (
      !currentEntry.searchEntries ||
      currentEntry.searchEntries.length === 0
    ) {
      throw new NotFoundError(`Entry ${dn} not found`);
    }

    // Get department path from target organization
    const departmentPath = await this.getDepartmentPath(targetOrgDn, req);

    // Launch pre-move hook (chained - can modify targetOrgDn or cancel)
    [, targetOrgDn] = await this.ownHooks.chain('move', [dn, targetOrgDn, req]);

    // Prepare LDAP modify request
    const changes: ModifyRequest = {
      replace: {
        [linkAttr]: targetOrgDn,
        [pathAttr]: departmentPath,
      },
    };

    // Execute the modification (will trigger onLdapChange hook)
    await this.modifyEntry(id, changes, req);

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
      const code = extractLdapCode(err);
      if (code === 32)
        throw new NotFoundError(`Organization ${orgDn} not found`);
      if (code === 34) throw new BadRequestError(`${orgDn} is not a valid DN`);
      throw new Error(`Failed to fetch organization ${orgDn}: ${String(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * List entries from LDAP.
   *
   * @returns the entries; {@link listEntriesLimited} also says whether
   *          `limit` left some out
   */
  async listEntries(options: ListEntriesOptions): Promise<LdapList> {
    return (await this.listEntriesLimited(options)).entries;
  }

  /**
   * List entries, and say whether some were left out.
   *
   * What the answers are is in docs/usage/plugins/ldap/flat-generic.md
   * ("Long lists"). What the code has to work around: a search carrying a
   * `sizeLimit` is never refused by ldapts — it returns the entries it got
   * and drops the result code, including when the server cut the answer at
   * its own, lower, limit. A bounded search therefore cannot prove a list
   * whole, and only serves as the fallback once the paged walk, which can,
   * has been refused. Its answer is flagged as truncated whatever it holds.
   *
   * @returns the entries, keyed by main attribute, and whether any were left
   *          out
   */
  async listEntriesLimited({
    filter,
    attributes,
    req,
    limit,
  }: ListEntriesOptions): Promise<{ entries: LdapList; truncated: boolean }> {
    const walk: SearchOptions = {
      // `limit + 2`: the branch's own entry, `limit` entries and the one
      // that says there are more, so that a first page can settle it.
      paged:
        limit === undefined ? true : { pageSize: Math.min(limit + 2, 100) },
      filter: filter || '(objectClass=*)',
    };
    if (attributes && attributes.length > 0) {
      // Entries are keyed, and counted, by the main attribute: a list that
      // leaves it out would drop every entry.
      const main = this.mainAttribute.toLowerCase();
      walk.attributes = attributes.some(a => a.toLowerCase() === main)
        ? attributes
        : [...attributes, this.mainAttribute];
    }
    // One collector for both searches: an `ldapsearchfilter` hook may have
    // let through, before the walk was refused, entries the bounded search
    // spends its `sizeLimit` on without returning.
    const list = entryCollector(this.mainAttribute, limit);
    try {
      const pages = (await this.ldap.search(
        walk,
        this.base,
        req
      )) as AsyncGenerator<SearchResult>;
      // A paged search fails from the walk, not from the call above. Leaving
      // the loop early returns the generator, which releases the connection.
      for await (const page of pages) {
        if (!list.add(page.searchEntries))
          return { entries: list.entries, truncated: true };
      }
      return { entries: list.entries, truncated: false };
    } catch (err) {
      if (limit === undefined || extractLdapCode(err) !== 4) throw err;
    }
    try {
      const bounded = (await this.ldap.search(
        {
          ...walk,
          paged: false,
          // One over: room for the branch's own entry, which is dropped.
          sizeLimit: Math.min(limit + 1, LDAP_MAX_INT),
        },
        this.base,
        req
      )) as SearchResult;
      list.add(bounded.searchEntries);
    } catch (err) {
      // Reached only if the bound was lost on the way — an `ldapsearchopts`
      // hook rewriting the options. ldapts then raises the refusal and drops
      // the entries sent before it, so all that is left to answer is that
      // some exist.
      if (extractLdapCode(err) !== 4) throw err;
    }
    return { entries: list.entries, truncated: true };
  }

  async searchEntriesByName(
    name: string,
    partial = false,
    attrs: string[] = [this.mainAttribute]
  ): Promise<LdapList> {
    // An identifier the schema admits has to survive the trip: the shipped
    // position and group schemas accept `( )` and `*`, which a raw
    // interpolation turns into an unparseable filter. A partial search means
    // the value to look for, not a pattern to run.
    const escaped = escapeLdapFilter(name);
    const filter = partial
      ? `(${this.mainAttribute}=*${escaped}*)`
      : `(${this.mainAttribute}=${escaped})`;
    return await this.listEntries({ filter, attributes: attrs });
  }

  /** @returns the entry to write, under the schema's spellings */
  async validateNewEntry(
    dn: string,
    entry: AttributesList
  ): Promise<AttributesList> {
    return await this.validator().validateNew(entry);
  }

  async validateChanges(dn: string, changes: ModifyRequest): Promise<boolean> {
    await this.validator().validateChanges(changes);
    return true;
  }
}
