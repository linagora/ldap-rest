/**
 * @module plugins/ldap/raw
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Low-level LDAP browsing API (read-only).
 *
 * Where the other plugins expose business objects (users, groups,
 * organizations), this one exposes the directory itself: the root DSE, the
 * schema, and entries addressed by their DN. It is the server side of a
 * phpLDAPadmin-like interface.
 *
 * Every directory access goes through `server.ldap`, so the authorization,
 * trash and logging hooks apply exactly as they do for the high-level APIs.
 * Root DSE and schema are directory metadata rather than user data and are
 * read with the service account, so that a UI can render attribute names and
 * types even when the caller is restricted to a branch.
 */
import type { Express, Request } from 'express';
import { FilterParser } from 'ldapts';
import type { SearchOptions, SearchResult } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import { tryMethodData } from '../../lib/expressFormatedResponses';
import {
  asyncHandler,
  isDnInBranch,
  getParentDn,
  getRdn,
} from '../../lib/utils';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors';
import {
  parseSchema,
  SchemaIndex,
  type LdapSchema,
} from '../../lib/ldapSchema';
import type { AttributeValue } from '../../lib/ldapActions';

/**
 * Shared OpenAPI schemas surfaced by this plugin. Picked up by
 * scripts/generate-openapi.ts and merged into `components.schemas`.
 *
 * @openapi-component
 * RawAttribute:
 *   type: object
 *   description: |
 *     Values of a single attribute. When `binary` is true the values are
 *     base64-encoded octets rather than text.
 *   required: [values, binary]
 *   properties:
 *     values:
 *       type: array
 *       items: { type: string }
 *       example: [Alice Smith]
 *     binary: { type: boolean, example: false }
 * RawEntry:
 *   type: object
 *   description: A directory entry with all its attributes, as stored.
 *   required: [dn, attributes]
 *   properties:
 *     dn:
 *       type: string
 *       example: uid=alice,ou=users,dc=example,dc=com
 *     attributes:
 *       type: object
 *       additionalProperties: { $ref: '#/components/schemas/RawAttribute' }
 *   example:
 *     dn: uid=alice,ou=users,dc=example,dc=com
 *     attributes:
 *       objectClass: { values: [top, inetOrgPerson], binary: false }
 *       uid: { values: [alice], binary: false }
 *       cn: { values: [Alice Smith], binary: false }
 * RawChild:
 *   type: object
 *   description: Direct child of an entry, as needed to draw a tree node.
 *   required: [dn, rdn, objectClass, hasChildren]
 *   properties:
 *     dn: { type: string, example: uid=alice,ou=users,dc=example,dc=com }
 *     rdn: { type: string, example: uid=alice }
 *     objectClass:
 *       type: array
 *       items: { type: string }
 *       example: [top, inetOrgPerson]
 *     hasChildren:
 *       type: boolean
 *       description: |
 *         Whether the entry has at least one child. Only computed when the
 *         `children` query parameter is set, otherwise always false.
 *       example: false
 */

/** JSON representation of one attribute of an entry */
export interface RawAttribute {
  /** Values, base64-encoded when `binary` is true */
  values: string[];
  binary: boolean;
}

/** JSON representation of a directory entry */
export interface RawEntry {
  dn: string;
  attributes: Record<string, RawAttribute>;
}

/** Direct child of an entry, as needed to draw a tree node */
export interface RawChild {
  dn: string;
  rdn: string;
  objectClass: string[];
  hasChildren: boolean;
}

/** Direct children of an entry, with the truncation flag */
export interface RawChildren {
  children: RawChild[];
  /** True when `ldap_raw_max_results` cut the listing short */
  truncated: boolean;
}

/** Result of a raw search */
export interface RawSearchResult {
  entries: RawEntry[];
  /** True when `ldap_raw_max_results` cut the result set short */
  truncated: boolean;
}

const VALID_SCOPES = ['base', 'one', 'sub'] as const;
type Scope = (typeof VALID_SCOPES)[number];

/**
 * Attributes holding credential material, hidden unless
 * `--ldap-raw-show-secrets` says otherwise. A password hash handed over
 * HTTP is an offline cracking target, and a directory browser has no need
 * to display one to do its job — so the safe reading is the default and
 * the permissive one is opt-in. Covers OpenLDAP, Samba, Kerberos and AD
 * spellings; add site-specific ones with `--ldap-raw-hidden-attribute`.
 */
const SECRET_ATTRIBUTES = [
  'userpassword',
  'pwdhistory',
  'sambantpassword',
  'sambalmpassword',
  'sambapasswordhistory',
  'krbprincipalkey',
  'krbextradata',
  'krbpwdhistory',
  'unicodepwd',
  'dbcspwd',
  'lmpwdhistory',
  'ntpwdhistory',
  'supplementalcredentials',
  'userpkcs12',
  'authpassword',
];

export default class LdapRaw extends DmPlugin {
  name = 'ldapRaw';
  roles: Role[] = ['api'] as const;

  /** Subtrees the API is allowed to expose */
  bases: string[];
  /** Attributes never returned, whatever the request (lowercase) */
  hiddenAttributes: Set<string>;
  /** True when credential attributes are served instead of being hidden */
  showSecrets: boolean;
  /** Maximum entries returned by a search or a children listing */
  maxResults: number;
  private schemaCacheTtl: number;
  private schemaCache?: { index: SchemaIndex; fetchedAt: number };
  private schemaPromise?: Promise<SchemaIndex>;

  constructor(server: DM) {
    super(server);

    const configured = this.config.ldap_raw_base || [];
    const bases = configured.filter(b => b && b.length > 0);
    if (bases.length === 0) {
      if (!this.config.ldap_base)
        throw new Error(
          'Missing --ldap-base or --ldap-raw-base for plugin core/ldap/raw'
        );
      bases.push(this.config.ldap_base);
    }
    this.bases = bases;

    this.showSecrets = this.config.ldap_raw_show_secrets === true;
    this.hiddenAttributes = new Set([
      ...(this.showSecrets ? [] : SECRET_ATTRIBUTES),
      ...(this.config.ldap_raw_hidden_attribute || [])
        .filter(a => a && a.length > 0)
        .map(a => a.toLowerCase()),
    ]);
    this.maxResults = this.config.ldap_raw_max_results || 200;
    this.schemaCacheTtl =
      (this.config.ldap_raw_schema_cache_ttl ?? 3600) * 1000;

    this.logger.info(
      `LDAP raw API enabled on ${this.bases.join(', ')} (read-only)`
    );
    if (this.showSecrets)
      this.logger.warn(
        'LDAP raw API: --ldap-raw-show-secrets is set, password hashes ' +
          'and other credential attributes are served over the API'
      );
  }

  /**
   * Reject any DN outside the configured bases. Authorization plugins narrow
   * access further; this is the coarse boundary of the API itself.
   *
   * @param dn DN to check
   * @throws BadRequestError when the DN is empty
   * @throws ForbiddenError when the DN is outside every configured base
   */
  checkDn(dn: string): void {
    if (!dn || !dn.trim()) throw new BadRequestError('DN is required');
    const allowed = this.bases.some(
      base => isDnInBranch(dn, base) || dn.toLowerCase() === base.toLowerCase()
    );
    if (!allowed)
      throw new ForbiddenError(`DN ${dn} is outside the exposed bases`);
  }

  /**
   * Reject a malformed LDAP filter before it reaches the directory. Parsing
   * it here turns what would surface as an opaque server error into a 400
   * naming the offending expression — a search box hands us whatever the
   * user typed, and `gov` is a filter typo, not a server fault.
   *
   * @param filter filter to validate
   * @throws BadRequestError when the filter cannot be parsed
   */
  checkFilter(filter: string): void {
    try {
      FilterParser.parseString(filter);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BadRequestError(
        `Invalid LDAP filter ${JSON.stringify(filter)}: ${detail}. ` +
          'A filter must be parenthesised, e.g. (cn=foo) or (|(cn=*foo*)(ou=*foo*))'
      );
    }
  }

  /**
   * Convert an ldapts entry into its JSON representation: values are always
   * arrays and hidden attributes are dropped.
   *
   * ldapts hands back a `Buffer` for values it could not decode as UTF-8 and
   * for the attribute types it knows to be binary; those are the ones that
   * need base64. A hashed `userPassword` is valid UTF-8 and stays readable,
   * which is what an administration UI wants to display.
   *
   * @param entry entry as returned by ldapts
   * @returns JSON-serializable entry
   */
  formatEntry(entry: Record<string, unknown> & { dn: string }): RawEntry {
    const attributes: Record<string, RawAttribute> = {};
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'dn') continue;
      // ldapts echoes back every requested attribute, so the `*` and `+`
      // wildcards come back as empty entries of their own
      if (name === '*' || name === '+' || name === '1.1') continue;
      if (this.hiddenAttributes.has(name.split(';')[0].toLowerCase())) continue;

      const rawValues = Array.isArray(value) ? value : [value];
      const binary = rawValues.some(v => Buffer.isBuffer(v));
      attributes[name] = {
        values: rawValues.map(v =>
          Buffer.isBuffer(v)
            ? v.toString('base64')
            : binary
              ? Buffer.from(String(v), 'utf8').toString('base64')
              : String(v)
        ),
        binary,
      };
    }
    return { dn: entry.dn, attributes };
  }

  /**
   * Run a search and turn the directory's "no such object" result code (32)
   * into a 404, instead of letting it surface as a server error.
   *
   * @param base search base
   * @param options search options
   * @param req incoming request, forwarded to the authorization hooks
   * @returns the search result
   * @throws NotFoundError when the base does not exist
   */
  private async searchDirectory(
    base: string,
    options: SearchOptions,
    req?: Request
  ): Promise<SearchResult> {
    try {
      return (await this.server.ldap.search(
        { paged: false, ...options },
        base,
        req
      )) as SearchResult;
    } catch (err) {
      if ((err as { code?: number })?.code === 32)
        throw new NotFoundError(`Entry ${base || '(root DSE)'} not found`);
      throw err;
    }
  }

  /**
   * Read the root DSE: naming contexts, supported controls and extensions,
   * and the DN of the subschema entry.
   *
   * @returns root DSE as a JSON entry (its `dn` is the empty string)
   */
  async getRootDse(): Promise<RawEntry> {
    const result = await this.searchDirectory('', {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['*', '+'],
    });
    const entry = result.searchEntries[0];
    if (!entry) throw new NotFoundError('Root DSE is not readable');
    return this.formatEntry({ ...entry, dn: '' });
  }

  /**
   * Locate the subschema entry advertised by the root DSE, falling back to
   * the conventional `cn=Subschema` when the server does not advertise one.
   *
   * @returns DN of the subschema entry
   */
  async getSubschemaDn(): Promise<string> {
    try {
      const result = await this.searchDirectory('', {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['subschemaSubentry'],
      });
      const value = result.searchEntries[0]?.subschemaSubentry;
      const dn = Array.isArray(value) ? value[0] : value;
      if (dn) return String(dn);
    } catch (err) {
      this.logger.warn(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Unable to read subschemaSubentry from root DSE: ${err}`
      );
    }
    return 'cn=Subschema';
  }

  /**
   * Fetch and parse the directory schema, with a cache: it is large and
   * changes rarely. Concurrent callers share a single fetch.
   *
   * @returns indexed schema
   */
  async getSchemaIndex(): Promise<SchemaIndex> {
    if (
      this.schemaCache &&
      Date.now() - this.schemaCache.fetchedAt < this.schemaCacheTtl
    )
      return this.schemaCache.index;
    if (this.schemaPromise) return this.schemaPromise;

    this.schemaPromise = (async (): Promise<SchemaIndex> => {
      const dn = await this.getSubschemaDn();
      const result = await this.searchDirectory(dn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: [
          'objectClasses',
          'attributeTypes',
          'ldapSyntaxes',
          'matchingRules',
        ],
      });
      const entry = result.searchEntries[0];
      if (!entry) throw new NotFoundError(`Subschema entry ${dn} not found`);

      const list = (value: AttributeValue | undefined): string[] => {
        if (value === undefined) return [];
        const values: (Buffer | string)[] = Array.isArray(value)
          ? value
          : [value];
        return values.map(v => (Buffer.isBuffer(v) ? v.toString('utf8') : v));
      };

      const index = new SchemaIndex(
        parseSchema({
          objectClasses: list(entry.objectClasses),
          attributeTypes: list(entry.attributeTypes),
          ldapSyntaxes: list(entry.ldapSyntaxes),
          matchingRules: list(entry.matchingRules),
        })
      );
      this.schemaCache = { index, fetchedAt: Date.now() };
      this.logger.info(
        `LDAP schema loaded from ${dn}: ` +
          `${index.schema.objectClasses.length} object classes, ` +
          `${index.schema.attributeTypes.length} attribute types`
      );
      return index;
    })();

    try {
      return await this.schemaPromise;
    } finally {
      this.schemaPromise = undefined;
    }
  }

  /**
   * Parsed schema, as served to clients.
   *
   * @returns object classes, attribute types, syntaxes and matching rules
   */
  async getSchema(): Promise<LdapSchema> {
    return (await this.getSchemaIndex()).schema;
  }

  /**
   * Read a single entry by DN, operational attributes included.
   *
   * @param dn DN of the entry
   * @param req incoming request, forwarded to the authorization hooks
   * @returns the entry
   * @throws NotFoundError when the DN does not exist
   */
  async getEntry(dn: string, req?: Request): Promise<RawEntry> {
    this.checkDn(dn);
    const read = async (attributes: string[]): Promise<SearchResult> =>
      this.searchDirectory(
        dn,
        { scope: 'base', filter: '(objectClass=*)', attributes },
        req
      );

    let result: SearchResult;
    try {
      result = await read(['*', '+']);
    } catch (err) {
      // A refusal by an authorization hook must not be retried
      if (
        err instanceof Error &&
        ('statusCode' in err || /\[authz-forbidden\]/.test(err.message))
      )
        throw err;
      // Not every server understands the `+` operational-attributes shortcut
      this.logger.debug(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        `Reading ${dn} with operational attributes failed (${err}), retrying without`
      );
      result = await read(['*']);
    }
    const entry = result.searchEntries[0];
    if (!entry) throw new NotFoundError(`Entry ${dn} not found`);
    return this.formatEntry(entry);
  }

  /**
   * List the direct children of an entry.
   *
   * @param dn DN of the parent entry
   * @param withChildrenFlag when true, probe each child for its own children
   *                         (one extra search per child)
   * @param req incoming request, forwarded to the authorization hooks
   * @returns children sorted by RDN, flagged as truncated when the branch
   *          holds more than `--ldap-raw-max-results` entries
   */
  async getChildren(
    dn: string,
    withChildrenFlag: boolean,
    req?: Request
  ): Promise<RawChildren> {
    this.checkDn(dn);
    // Ask for one entry more than the limit to detect truncation
    const result = await this.searchDirectory(
      dn,
      {
        scope: 'one',
        filter: '(objectClass=*)',
        attributes: ['objectClass'],
        sizeLimit: this.maxResults + 1,
      },
      req
    );

    const truncated = result.searchEntries.length > this.maxResults;
    const children: RawChild[] = [];
    for (const entry of result.searchEntries.slice(0, this.maxResults)) {
      const objectClass = entry.objectClass;
      children.push({
        dn: entry.dn,
        rdn: getRdn(entry.dn),
        objectClass: Array.isArray(objectClass)
          ? objectClass.map(String)
          : objectClass
            ? [String(objectClass)]
            : [],
        hasChildren: false,
      });
    }
    children.sort((a, b) => a.rdn.localeCompare(b.rdn));

    if (withChildrenFlag)
      await Promise.all(
        children.map(async child => {
          child.hasChildren = await this.hasChildren(child.dn, req);
        })
      );

    if (truncated)
      this.logger.info(
        `Children of ${dn} truncated to ${this.maxResults} entries`
      );
    return { children, truncated };
  }

  /**
   * Tell whether an entry has at least one child.
   *
   * @param dn DN of the entry
   * @param req incoming request, forwarded to the authorization hooks
   * @returns true when a child exists, false on error or empty result
   */
  async hasChildren(dn: string, req?: Request): Promise<boolean> {
    try {
      const result = await this.searchDirectory(
        dn,
        {
          scope: 'one',
          filter: '(objectClass=*)',
          attributes: ['1.1'],
          sizeLimit: 1,
        },
        req
      );
      return result.searchEntries.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Run an arbitrary search below one of the exposed bases.
   *
   * @param options base, scope, filter and attributes of the search
   * @param req incoming request, forwarded to the authorization hooks
   * @returns matching entries, flagged as truncated when the limit was hit
   */
  async search(
    options: {
      base: string;
      scope: Scope;
      filter: string;
      attributes?: string[];
      limit?: number;
    },
    req?: Request
  ): Promise<RawSearchResult> {
    this.checkDn(options.base);
    this.checkFilter(options.filter);
    const limit = Math.min(options.limit || this.maxResults, this.maxResults);

    // Ask for one entry more than the limit to detect truncation
    const result = await this.searchDirectory(
      options.base,
      {
        scope: options.scope,
        filter: options.filter,
        attributes: options.attributes?.length ? options.attributes : ['*'],
        sizeLimit: limit + 1,
      },
      req
    );

    const truncated = result.searchEntries.length > limit;
    const entries = result.searchEntries
      .slice(0, limit)
      .map(entry => this.formatEntry(entry));
    return { entries, truncated };
  }

  /**
   * Parent DN of an entry, or null when it is one of the exposed bases.
   *
   * @param dn DN of the entry
   * @returns parent DN, or null when the entry is a root of the API
   */
  parentOf(dn: string): string | null {
    if (this.bases.some(base => dn.toLowerCase() === base.toLowerCase()))
      return null;
    const parent = getParentDn(dn);
    return parent && parent !== dn ? parent : null;
  }

  api(app: Express): void {
    const prefix = `${this.config.api_prefix}/v1/ldap/raw`;

    /**
     * @openapi
     * summary: List the exposed bases
     * description: |
     *   Entry points of the low-level API: the subtrees the server is
     *   configured to expose (`--ldap-raw-base`, defaulting to `--ldap-base`).
     * responses:
     *   '200':
     *     description: Exposed bases.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             bases:
     *               type: array
     *               items: { type: string }
     *         example:
     *           bases: [dc=example,dc=com]
     */
    app.get(
      `${prefix}/bases`,
      asyncHandler(async (req, res) => {
        await tryMethodData(res, () => ({ bases: this.bases }));
      })
    );

    /**
     * @openapi
     * summary: Read the root DSE
     * description: |
     *   Server capabilities: naming contexts, supported controls, extensions
     *   and the DN of the subschema entry. Read with the service account, as
     *   directory metadata rather than user data.
     * responses:
     *   '200':
     *     description: Root DSE.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/RawEntry' }
     *   '404':
     *     description: Root DSE is not readable.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${prefix}/rootdse`,
      asyncHandler(async (req, res) => {
        await tryMethodData(res, this.getRootDse.bind(this));
      })
    );

    /**
     * @openapi
     * summary: Read the directory schema
     * description: |
     *   Parsed content of the subschema entry: object classes (with their
     *   `MUST`/`MAY` attributes and `SUP` chain), attribute types, syntaxes
     *   and matching rules. Cached for `--ldap-raw-schema-cache-ttl` seconds.
     * responses:
     *   '200':
     *     description: Parsed schema.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             objectClasses: { type: array, items: { type: object } }
     *             attributeTypes: { type: array, items: { type: object } }
     *             syntaxes: { type: array, items: { type: object } }
     *             matchingRules: { type: array, items: { type: object } }
     *   '404':
     *     description: Subschema entry not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${prefix}/schema`,
      asyncHandler(async (req, res) => {
        await tryMethodData(res, this.getSchema.bind(this));
      })
    );

    /**
     * @openapi
     * summary: Search the directory
     * description: |
     *   Raw LDAP search. `base` must be inside one of the exposed bases, and
     *   the usual authorization hooks apply on top of that.
     * parameters:
     *   - in: query
     *     name: base
     *     schema: { type: string }
     *     description: Search base. Defaults to the first exposed base.
     *     example: ou=users,dc=example,dc=com
     *   - in: query
     *     name: scope
     *     schema: { type: string, enum: [base, one, sub] }
     *     description: Search scope (default `sub`).
     *   - in: query
     *     name: filter
     *     schema: { type: string }
     *     description: LDAP filter (default `(objectClass=*)`).
     *     example: (uid=alice)
     *   - in: query
     *     name: attributes
     *     schema: { type: string }
     *     description: Comma-separated attribute list (default `*`).
     *     example: uid,cn,mail
     *   - in: query
     *     name: limit
     *     schema: { type: integer }
     *     description: |
     *       Maximum number of entries, capped by `--ldap-raw-max-results`.
     * responses:
     *   '200':
     *     description: Matching entries.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             entries:
     *               type: array
     *               items: { $ref: '#/components/schemas/RawEntry' }
     *             truncated: { type: boolean }
     *   '400':
     *     description: |
     *       Invalid scope, invalid limit, or unparseable LDAP filter. The
     *       message names the offending filter and recalls the expected
     *       form, e.g. `Invalid LDAP filter "gov"`.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '403':
     *     description: Base outside the exposed subtrees.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${prefix}/search`,
      asyncHandler(async (req, res) => {
        const scope = (req.query.scope as string) || 'sub';
        if (!VALID_SCOPES.includes(scope as Scope))
          throw new BadRequestError(
            `Invalid scope "${scope}", expected one of ${VALID_SCOPES.join(', ')}`
          );
        const attributes =
          typeof req.query.attributes === 'string'
            ? req.query.attributes
                .split(',')
                .map(a => a.trim())
                .filter(Boolean)
            : undefined;
        const limit =
          typeof req.query.limit === 'string'
            ? parseInt(req.query.limit, 10)
            : undefined;
        if (limit !== undefined && (isNaN(limit) || limit < 1))
          throw new BadRequestError('limit must be a positive integer');

        await tryMethodData(
          res,
          this.search.bind(this),
          {
            base: (req.query.base as string) || this.bases[0],
            scope: scope as Scope,
            filter: (req.query.filter as string) || '(objectClass=*)',
            attributes,
            limit,
          },
          req
        );
      })
    );

    /**
     * @openapi
     * summary: List the children of an entry
     * description: |
     *   Direct children (scope `one`) of the URL-encoded `:dn`, as needed to
     *   expand a tree node. At most `--ldap-raw-max-results` entries are
     *   returned; `truncated` tells whether the branch holds more.
     * parameters:
     *   - in: query
     *     name: children
     *     schema: { type: boolean }
     *     description: |
     *       When set, each child is probed for children of its own so the UI
     *       can decide whether to draw an expand arrow. Costs one extra
     *       search per child.
     * responses:
     *   '200':
     *     description: Direct children, sorted by RDN.
     *     content:
     *       application/json:
     *         schema:
     *           type: object
     *           properties:
     *             children:
     *               type: array
     *               items: { $ref: '#/components/schemas/RawChild' }
     *             truncated: { type: boolean }
     *   '403':
     *     description: DN outside the exposed subtrees.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${prefix}/children/:dn`,
      asyncHandler(async (req, res) => {
        const dn = decodeURIComponent(req.params.dn as string);
        const withChildren =
          req.query.children !== undefined && req.query.children !== 'false';
        await tryMethodData(
          res,
          this.getChildren.bind(this),
          dn,
          withChildren,
          req
        );
      })
    );

    /**
     * @openapi
     * summary: Read an entry
     * description: |
     *   Full content of the URL-encoded `:dn`, operational attributes
     *   included. Binary values are base64-encoded and flagged as such.
     *   Attributes listed in `--ldap-raw-hidden-attribute` are omitted.
     * responses:
     *   '200':
     *     description: The entry.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/RawEntry' }
     *   '403':
     *     description: DN outside the exposed subtrees.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: Entry not found.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${prefix}/entry/:dn`,
      asyncHandler(async (req, res) => {
        const dn = decodeURIComponent(req.params.dn as string);
        await tryMethodData(res, this.getEntry.bind(this), dn, req);
      })
    );
  }

  /**
   * Expose the API settings to the config API, so a UI can adapt itself
   * (bases to display, read-only mode).
   *
   * @returns public configuration of this plugin
   */
  getConfigApiData(): Record<string, unknown> {
    return {
      bases: this.bases,
      readOnly: true,
      maxResults: this.maxResults,
      hiddenAttributes: [...this.hiddenAttributes],
      showSecrets: this.showSecrets,
    };
  }
}
