/**
 * LDAP low-level library
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { createHash } from 'node:crypto';

import type { Request } from 'express';
import { Client, Attribute, Change, Control } from 'ldapts';
import type { ClientOptions, SearchResult, SearchOptions } from 'ldapts';
import type winston from 'winston';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';

import { type Config } from '../config/args';
import { type DM } from '../bin';
import type { Hooks } from '../hooks';

import {
  escapeDnValue,
  getParentDn,
  hookOwner,
  isAuthzRefusal,
  isDnInBranch,
  knownAttributeName,
  launchHooks,
  launchHooksChained,
  normalizeDn,
  rdnTypes,
} from './utils';
import { changeContext, type ChangeContext } from './changeContext';
import { outsideOperation, runOperation } from './operation';
import { currentRequest, outsideRequest } from './requestContext';
import { BadRequestError, ConflictError, NotFoundError } from './errors';
import { extractLdapCode, isSchemaRefusal } from './ldapCodes';
import { parseSchema, SchemaIndex } from './ldapSchema';

// Typescript interface

// Entry
export type AttributeValue = Buffer | Buffer[] | string[] | string;
export type AttributesList = Record<string, AttributeValue>;
export type LdapList = Record<string, AttributesList>;

// Connection pool entry
interface PooledConnection {
  client: Client;
  createdAt: number;
  inUse: boolean;
}

// search
const defaultSearchOptions: SearchOptions = {
  scope: 'sub',
  filter: '(objectClass=*)',
  attributes: ['*'],
  sizeLimit: 0,
  timeLimit: 10,
  paged: {
    pageSize: 100,
  },
};
export type { SearchOptions, SearchResult };

/** Where each judged hook takes the request in its arguments. */
const AUTHORIZED_REQUEST_AT: Record<AuthorizedHook, number> = {
  ldapaddrequest: 2,
  ldapmodifyrequest: 3,
  ldaprenamerequest: 2,
  ldapdeleterequest: 1,
};

/** The operations {@link ldapActions.system} makes as the server. */
const SYSTEM_OPERATIONS = new Set<string | symbol>([
  'search',
  'add',
  'modify',
  'rename',
  'move',
  'delete',
]);

/**
 * The directory as seen by one HTTP request.
 *
 * `ldapActions`'s own methods take the request as a trailing optional
 * argument, which the authorization plugins judge by. One naming none is
 * made for the request being served, if any (#385); this says which
 * request is meant rather than leaving it to the context.
 *
 * These methods take no request parameter: it is captured once by
 * `ldapActions.forRequest()`. Request handlers should bind once and use
 * this; the server's own work goes through {@link ldapActions.system}.
 */
export interface RequestBoundLdap {
  search(
    options: SearchOptions,
    base?: string
  ): Promise<SearchResult | AsyncGenerator<SearchResult>>;
  add(dn: string, entry: AttributesList): Promise<boolean>;
  modify(
    dn: string,
    changes: ModifyRequest,
    options?: ModifyOptions
  ): Promise<boolean>;
  rename(dn: string, newRdn: string): Promise<boolean>;
  delete(dn: string | string[]): Promise<boolean>;
}

// modify
export interface ModifyRequest {
  add?: AttributesList;
  replace?: AttributesList;
  delete?: string[] | AttributesList;
}

const isPlainObject = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Refuse a modify body a client got wrong: any other key was ignored, and a
 * body naming no attribute in `add`, `replace` or `delete` answered success
 * without changing anything.
 *
 * @param body parsed request body
 * @throws BadRequestError naming what is wrong
 */
export function assertModifyRequest(
  body: object
): asserts body is ModifyRequest {
  const keys = Object.keys(body);
  const unknown = keys.filter(k => !['add', 'replace', 'delete'].includes(k));
  if (unknown.length > 0)
    throw new BadRequestError(
      `A modification carries add, replace or delete, not ${unknown.join(', ')}`
    );
  const { add, replace, delete: del } = body as Record<string, unknown>;
  for (const [name, part] of [
    ['add', add],
    ['replace', replace],
  ] as const)
    if (part !== undefined && !isPlainObject(part))
      throw new BadRequestError(`"${name}" must map attributes to values`);
  if (
    del !== undefined &&
    !isPlainObject(del) &&
    !(Array.isArray(del) && del.every(v => typeof v === 'string'))
  )
    throw new BadRequestError(
      '"delete" must list attribute names or map attributes to values'
    );
  const named = [add, replace, del].reduce<number>(
    (n, part) => n + (part ? Object.keys(part).length : 0),
    0
  );
  if (named === 0)
    throw new BadRequestError(
      'A modification names at least one attribute in add, replace or delete'
    );
}

export interface ModifyOptions {
  /**
   * Send the permissive modify control, not critical: a directory that
   * honours it accepts an add of a value already there (OpenLDAP 2.4 still
   * refuses a delete of an absent one); one that does not ignores it.
   */
  permissive?: boolean;
  /**
   * The change context the write is announced with, for a write made on
   * behalf of a request but not authorized as it.
   */
  context?: ChangeContext;
  /**
   * Object classes the entry may be given besides those declared for its
   * branch, for a writer that knows what kind of entry it writes: an account
   * another tool created may lack the classes the write needs, see
   * ldapActions.classRepair.
   */
  declaredClasses?: string[];
}

const PERMISSIVE_MODIFY = '1.2.840.113556.1.4.1413';

// Code

/**
 * Wrap a driver error without losing its LDAP result code.
 *
 * These methods re-throw their own `Error` so the message says which
 * operation failed. That used to leave the numeric code — the only
 * dependable way for a caller to tell noSuchObject from
 * entryAlreadyExists, or a schema refusal from a server fault — recoverable
 * only by matching the driver's wording, which no driver promises to keep.
 * `Error.cause` would be the idiomatic home for it, but it is not in this
 * project's `lib` target; the code itself is what callers read, as
 * `extractLdapCode` finds it, message patterns included.
 */
function ldapError(context: string, error: unknown): Error {
  const wrapped = new Error(`${context}: ${String(error)}`);
  const code = extractLdapCode(error);
  return code === undefined ? wrapped : withCode(wrapped, code);
}

function withCode<T extends Error>(err: T, code: number): T {
  (err as { code?: number }).code = code;
  return err;
}

/**
 * Field separator of a search-cache key.
 *
 * NUL cannot appear unescaped in a DN (RFC 4514 writes it `\00`) nor in an
 * LDAP filter (RFC 4515 writes it `\00` too), so `invalidateCache` can split
 * the base DN back out of a key instead of guessing where it ends. A `:` —
 * what this used to join on — is a legal DN character.
 */
const CACHE_KEY_SEPARATOR = '\u0000';

/** The request hooks an operation is judged in, see `ldapActions.authorize` */
type AuthorizedHook =
  | 'ldapaddrequest'
  | 'ldapmodifyrequest'
  | 'ldapdeleterequest'
  | 'ldaprenamerequest';

/**
 * Short, stable stand-in for a cache key in a log line.
 *
 * The key is built from the search base, which comes from configuration and
 * therefore ultimately from the environment — logging it verbatim is what
 * CodeQL flags as clear-text logging of environment-derived data. A digest
 * carries none of the key's content, but the same key always digests to the
 * same token, so a "cache hit" line can still be matched back to the
 * "cached" line that filled the entry it hit.
 */
const digestKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 12);

/**
 * Fold a DN to the form cache keys are matched on.
 *
 * The directory compares DNs case-insensitively, and callers build them from
 * everywhere: a URL path, a configuration value, an attribute read back from
 * the server. `uid=Foo,dc=x` and `uid=foo,dc=x` name one entry, so a write
 * spelling it one way has to drop what a read spelling it the other stored.
 * Spacing around the separators is folded for the same reason.
 *
 * Folding serves matching only, never key building: a DN that two callers
 * spell differently costs two cache entries, and one write drops both. The
 * reverse — folding into the key itself — would merge two entries whose RDN
 * values differ only in case, which a case-exact naming attribute makes two
 * different entries.
 *
 * Written as a split/trim/join rather than a `\s*,\s*` regex: that shape is
 * polynomial-backtracking on a long run of spaces containing no comma, and
 * `dn` comes from caller-controlled input (a URL path segment, among
 * others), so the cost was quadratic in an attacker-chosen length. Splitting
 * on the literal comma and trimming each part does the same folding in
 * linear time.
 */
const foldDn = (dn: string): string =>
  dn
    .trim()
    .toLowerCase()
    .split(',')
    .map(part => part.trim())
    .join(',');

/**
 * Group attributes the `memberof` overlay mirrors onto the entries they name,
 * as their `memberOf`. Lowercase, as attribute names compare.
 */
const MEMBERSHIP_ATTRIBUTES = new Set(['member', 'uniquemember']);

const isMembershipAttribute = (name: string): boolean =>
  MEMBERSHIP_ATTRIBUTES.has(name.toLowerCase());

/** The DNs that attributes of an entry or a change name as members. */
const membersNamed = (attributes: object | undefined): string[] =>
  Object.entries(attributes ?? {}).flatMap(([name, value]) =>
    isMembershipAttribute(name)
      ? ([value] as unknown[])
          .flat()
          .map(v => (Buffer.isBuffer(v) ? v.toString() : v))
          .filter((v): v is string => typeof v === 'string')
      : []
  );

/**
 * Copy a search result at the cache boundary.
 *
 * Without this the cache hands the very same object to every caller, and a
 * caller that edits the entry it was given edits what the next one reads.
 *
 * The entry is copied, and so is every value that is a list: an attribute
 * comes back as an array whenever it holds — or may hold — several values,
 * and `entry.member.push(…)` or `entry.objectClass.sort()` on a returned
 * entry would otherwise be a write into the cache, serving the result to
 * every later reader until the TTL ran out. No caller does that today; the
 * copy is what keeps that from being a rule nobody wrote down.
 *
 * What stays shared is the bytes of a `Buffer` value, which only a caller
 * writing into a binary attribute in place could reach, and which copying on
 * every hit would pay for on every deployment that never does.
 */
const cloneSearchResult = (result: SearchResult): SearchResult => ({
  searchEntries: result.searchEntries.map(entry =>
    Object.fromEntries(
      Object.entries(entry).map(([name, value]) => [
        name,
        Array.isArray(value) ? [...value] : value,
      ])
    )
  ) as SearchResult['searchEntries'],
  searchReferences: [...result.searchReferences],
});

/**
 * ldapts gives every requested attribute the entry lacks an empty list, so
 * the `*`, `+` and `1.1` selectors came back as attributes of their own.
 */
const SELECTORS = ['*', '+', '1.1'];
const dropSelectors = (result: SearchResult): SearchResult => {
  for (const entry of result.searchEntries)
    for (const name of SELECTORS) {
      const value = (entry as Record<string, unknown>)[name];
      if (Array.isArray(value) && value.length === 0)
        delete (entry as Record<string, unknown>)[name];
    }
  return result;
};
async function* dropSelectorsPaged(
  pages: AsyncGenerator<SearchResult>
): AsyncGenerator<SearchResult> {
  for await (const page of pages) yield dropSelectors(page);
}

/**
 * A 400 for a write the directory refused for what it asks, carrying the
 * LDAP code for callers that map it themselves.
 *
 * The client is told the directory's diagnostic, which names the attribute
 * at fault ("mailQuota: attribute type undefined"), not the value sent.
 */
function ldapRefusal(what: string, code: number, error: unknown): Error {
  return withCode(new BadRequestError(`${what}: ${String(error)}`), code);
}

/**
 * An empty list adds nothing: the directory answers a protocol error, which
 * reached the client as a 500. A replace with no value is how an attribute
 * is cleared, and does not come here.
 */
function assertHasValue(name: string, value: unknown): void {
  if (Array.isArray(value) && value.length === 0)
    throw new BadRequestError(`Attribute "${name}" has no value`);
}

/**
 * Wrap a write failure, turning a refusal of the request's content (see
 * `isSchemaRefusal`) into a 400: the mistake is the client's, and a 500
 * would hide it in logs it cannot read.
 */
function ldapWriteError(context: string, dn: string, error: unknown): Error {
  const code = extractLdapCode(error);
  return isSchemaRefusal(code)
    ? ldapRefusal(`The directory refused this write to ${dn}`, code!, error)
    : ldapError(context, error);
}

/**
 * Wrap an add failure, turning entryAlreadyExists (68) into a 409.
 *
 * Every creation route ends here, so this is the one place that knows a
 * duplicate is a conflict: mapped in each caller instead, the flat routes
 * answered 409 while `POST /ldap/groups` and the organization routes turned
 * the same refusal into a 500. The checks callers run look before writing, so
 * two creations of the same entry sent at once both pass them and the
 * directory refuses the second — a bulk import whose file holds one person
 * twice does exactly that. That is a conflict, not a fault.
 *
 * The numeric code is carried over onto the `ConflictError`: callers that
 * read it to recognise a duplicate (SCIM's uniqueness mapping, the
 * idempotent applicative-account creation) keep working unchanged.
 */
function ldapAddError(dn: string, error: unknown): Error {
  const code = extractLdapCode(error);
  if (code === 68)
    return withCode(new ConflictError(`Entry ${dn} already exists`), code);
  // The branch it goes in: a flat entity's base nothing created yet
  if (code === 32)
    return withCode(
      new NotFoundError(`${getParentDn(dn)} does not exist`),
      code
    );
  // attributeOrValueExists, on an add: the request names a value twice
  if (code === 20)
    return ldapRefusal(
      `The directory refused this write to ${dn}`,
      code,
      error
    );
  return ldapWriteError('LDAP add error', dn, error);
}

/**
 * Wrap a modify failure, turning objectClassViolation (65) and
 * attributeOrValueExists (20) into a 409: the entry is not of a kind that can
 * hold what was written, typically one created by another tool without a
 * class its schema declares, or already holds the value added. A missing
 * entry (32) or value to delete (16) is a 404. The code is carried over for
 * callers that map it themselves.
 */
function ldapModifyError(dn: string, error: unknown): Error {
  const code = extractLdapCode(error);
  if (code === 32)
    return withCode(new NotFoundError(`Entry ${dn} not found`), code);
  if (code === 16)
    return withCode(
      new NotFoundError(`Entry ${dn} does not hold the value to delete`),
      code
    );
  if (code !== 65 && code !== 20)
    return ldapWriteError('LDAP modify error', dn, error);
  return withCode(
    new ConflictError(`Entry ${dn} cannot hold this change: ${String(error)}`),
    code
  );
}

/**
 * Wrap a rename or move failure: a new DN already taken (68) is a 409, as on
 * an add, and a refusal of the request's content a 400 naming both DNs, the
 * new one being what the directory usually refused.
 */
function ldapRenameError(
  context: string,
  dn: string,
  newDn: string,
  error: unknown
): Error {
  const code = extractLdapCode(error);
  if (code === 68)
    return withCode(new ConflictError(`Entry ${newDn} already exists`), code);
  return isSchemaRefusal(code)
    ? ldapRefusal(
        `The directory refused to rename ${dn} to ${newDn}`,
        code!,
        error
      )
    : ldapError(context, error);
}

class ldapActions {
  config: Config;
  options: ClientOptions;
  dn: string;
  pwd: string;
  base: string;
  parent: DM;
  logger: winston.Logger;
  private searchCache: LRUCache<string, SearchResult>;
  private cacheEnabled: boolean;
  /**
   * How many writes this instance has made since it was built.
   *
   * A read can be overtaken by a write: the write lands and `invalidateCache`
   * finds nothing to drop, because the read has not stored its answer yet —
   * and the read then stores what it read *before* the write, an entry
   * nothing will drop until its TTL runs out. `search()` remembers the count
   * it started at and stores only if no write happened in between, so a read
   * a write overtook costs a cache entry, never a stale answer.
   *
   * The count is per instance and per write, not per DN: a write to another
   * branch keeps a concurrent read out of the cache too. That is hit rate
   * given up, not freshness.
   */
  private cacheGeneration = 0;
  public queryLimit: ReturnType<typeof pLimit>;
  private connectionPool: PooledConnection[] = [];
  private poolSize: number;
  private connectionTtl: number; // in milliseconds
  private ldapUrls: string[];
  private currentUrlIndex: number = 0;
  // LRU cache for attribute signatures to prevent unbounded memory growth
  private attrSignatureCache: LRUCache<string, string>;
  private waitingResolvers: Array<(conn: PooledConnection) => void> = [];
  private availableConnections: PooledConnection[] = [];
  private isCleaningUp = false;
  /** See {@link declareObjectClasses}. */
  private declaredClasses = new Map<
    string,
    { base: string; classes: string[]; includeBase: boolean }
  >();
  private schemaCache?: { index: SchemaIndex; fetchedAt: number };
  private schemaLoading?: Promise<SchemaIndex>;
  /** Whether the last schema read failed, so a failure is logged once. */
  private schemaUnavailable = false;
  /**
   * How this server spells attribute names, by name in lower case: the
   * configuration's, then the loaded schemas'. See {@link canonicalName}.
   */
  private spellings = new Map<string, string>();
  /** The first name given for each attribute type, to warn of another. */
  private spelledTypes = new Map<string, string>();
  /** Class problems already reported, per entry. See {@link warnOnce}. */
  private classWarnings = new LRUCache<string, true>({ max: 10000 });

  constructor(server: DM) {
    this.parent = server;
    this.logger = server.logger;
    this.config = server.config;
    // The attribute names the options give: the plugins compare with these
    for (const [key, value] of Object.entries(this.config))
      if (/_attributes?$/.test(key))
        this.knowAttributeNames(
          [value].flat().filter((v): v is string => typeof v === 'string')
        );

    // Initialize connection pool settings
    this.poolSize = this.config.ldap_pool_size || 5;
    this.connectionTtl = (this.config.ldap_connection_ttl || 60) * 1000; // Convert to ms
    this.logger.info(
      `LDAP connection pool initialized: size=${this.poolSize}, ttl=${this.connectionTtl / 1000}s`
    );

    // Initialize global LDAP query concurrency limiter
    const concurrency = this.config.ldap_concurrency || 10;
    this.queryLimit = pLimit(concurrency);
    this.logger.info(
      `Global LDAP query concurrency limit set to ${concurrency}`
    );

    // Initialize LRU cache for search results
    const cacheMax: number =
      typeof this.config.ldap_cache_max === 'string'
        ? parseInt(this.config.ldap_cache_max, 10) || 1000
        : (this.config.ldap_cache_max ?? 1000);
    // `--ldap-cache-ttl` defaults to 0, and 0 means "do not cache".
    //
    // The branch that stored a result was unreachable until #166, so no
    // deployment has ever run with this cache actually caching. Switching it
    // on for everyone in the release that repairs it is how staleness nobody
    // can reproduce gets shipped: anything writing the directory without
    // going through this process — LSC, ldapmodify, a second replica of this
    // server — leaves this one answering the entry it read before, for the
    // whole TTL, and no write path here can know. A deployment that wants
    // the cache turns it on deliberately.
    const ttlSetting = this.config.ldap_cache_ttl;
    const cacheTtlSeconds =
      typeof ttlSetting === 'string'
        ? parseInt(ttlSetting, 10) || 0
        : (ttlSetting ?? 0);
    const cacheTtl = Math.max(cacheTtlSeconds, 0) * 1000; // seconds to ms
    this.cacheEnabled = cacheTtl > 0;
    this.searchCache = new LRUCache<string, SearchResult>({
      max: cacheMax,
      // An LRU built with `ttl: 0` expires nothing ever, which is the
      // opposite of what 0 asks for: the cache is switched off through
      // `cacheEnabled`, and then nothing is ever stored in it.
      ttl: this.cacheEnabled ? cacheTtl : undefined,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });
    this.logger.info(
      this.cacheEnabled
        ? `LDAP search cache initialized: max=${cacheMax}, ttl=${cacheTtl / 1000}s`
        : 'LDAP search cache disabled (--ldap-cache-ttl=0)'
    );
    // Initialize bounded LRU cache for attribute signatures
    this.attrSignatureCache = new LRUCache<string, string>({
      max: 1000, // Reasonable limit for attribute signature combinations
    });
    if (!server.config.ldap_url || server.config.ldap_url.length === 0) {
      throw new Error('LDAP URL is not defined');
    }
    if (!server.config.ldap_dn) {
      throw new Error(
        'LDAP bind DN is not defined, please set --ldap-dn (or DM_LDAP_DN)'
      );
    }
    if (!server.config.ldap_pwd) {
      throw new Error(
        'LDAP password is not defined, please set --ldap-pwd (or DM_LDAP_PWD)'
      );
    }
    // The base is the default search base (`search(options, base =
    // this.base)`) and the suffix `setDn()` builds DNs from, so a guessed one
    // reads and writes in the wrong place. The guess was
    // `ldap_dn.split(',', 2)[1]`, the second RDN of the bind DN only:
    // `cn=admin,dc=example,dc=com` gave `dc=example`, which is not an entry,
    // so every subtree search under it answered `NoSuchObject` (32).
    if (!server.config.ldap_base) {
      throw new Error(
        'LDAP base is not defined, please set --ldap-base (or DM_LDAP_BASE)'
      );
    }
    this.base = server.config.ldap_base;
    this.ldapUrls = server.config.ldap_url;
    this.logger.info(
      `LDAP failover configured with ${this.ldapUrls.length} URL(s): ${this.ldapUrls.join(', ')}`
    );
    this.options = {
      url: this.ldapUrls[0],
      timeout: 0,
      connectTimeout: 0,
      strictDN: false,
    };
    if (this.ldapUrls[0].startsWith('ldaps://')) {
      this.options.tlsOptions = {
        minVersion: 'TLSv1.2',
      };
    }
    this.dn = server.config.ldap_dn;
    this.pwd = server.config.ldap_pwd;
  }

  /**
   * Create a new LDAP connection with failover support
   */
  private async createConnection(): Promise<Client> {
    const errors: Error[] = [];

    // Try each URL in order
    for (let i = 0; i < this.ldapUrls.length; i++) {
      const urlIndex = (this.currentUrlIndex + i) % this.ldapUrls.length;
      const url = this.ldapUrls[urlIndex];

      try {
        this.logger.debug(`Attempting connection to ${url}`);
        const options: ClientOptions = {
          ...this.options,
          url,
          tlsOptions: url.startsWith('ldaps://')
            ? { minVersion: 'TLSv1.2' }
            : undefined,
        };

        const client: Client = new Client(options);
        await client.bind(this.dn, this.pwd);

        // Connection successful
        if (urlIndex !== this.currentUrlIndex) {
          this.logger.info(
            `LDAP failover: switched from ${this.ldapUrls[this.currentUrlIndex]} to ${url}`
          );
          this.currentUrlIndex = urlIndex;
        }

        return client;
      } catch (error) {
        this.logger.warn(`Failed to connect to ${url}: ${String(error)}`);
        errors.push(error as Error);
      }
    }

    // All URLs failed
    this.logger.error(
      `LDAP connection failed for all ${this.ldapUrls.length} URL(s)`
    );
    throw new Error(
      `LDAP connection failed for all URLs: ${errors.map(e => e.message).join(', ')}`
    );
  }

  /**
   * Clean up expired connections from the pool
   * Uses a flag to prevent concurrent cleanup operations
   */
  private cleanupExpiredConnections(): void {
    // Prevent concurrent cleanup operations
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    try {
      const now = Date.now();
      const expired: PooledConnection[] = [];

      // Clean from availableConnections queue (only these can expire as they're not in use)
      for (let i = this.availableConnections.length - 1; i >= 0; i--) {
        const conn = this.availableConnections[i];
        if (now - conn.createdAt > this.connectionTtl) {
          expired.push(conn);
          this.availableConnections.splice(i, 1);
          // Also remove from main pool
          const poolIdx = this.connectionPool.indexOf(conn);
          if (poolIdx !== -1) {
            this.connectionPool.splice(poolIdx, 1);
          }
        }
      }

      // Unbind expired connections asynchronously
      for (const conn of expired) {
        void conn.client.unbind().catch(err => {
          this.logger.debug(
            `Error unbinding expired connection: ${String(err)}`
          );
        });
      }

      if (expired.length > 0) {
        this.logger.debug(
          `Cleaned up ${expired.length} expired LDAP connections`
        );
      }
    } finally {
      this.isCleaningUp = false;
    }
  }

  /**
   * Acquire a connection from the pool or create a new one
   * Optimized for O(1) lookup using separate available connections queue
   */
  private async acquireConnection(): Promise<PooledConnection> {
    // Clean up expired connections
    this.cleanupExpiredConnections();

    // O(1) - Try to pop from available connections queue
    if (this.availableConnections.length > 0) {
      const conn = this.availableConnections.pop()!;
      conn.inUse = true;
      this.logger.debug('Reusing pooled LDAP connection');
      return conn;
    }

    // If pool is not full, create a new connection
    if (this.connectionPool.length < this.poolSize) {
      // Outside the request it is opened for: the connection outlives it
      const client = await outsideRequest(() => this.createConnection());
      const pooled: PooledConnection = {
        client,
        createdAt: Date.now(),
        inUse: true,
      };
      this.connectionPool.push(pooled);
      this.logger.debug(
        `Created new LDAP connection (pool: ${this.connectionPool.length}/${this.poolSize})`
      );
      return pooled;
    }

    // Pool is full, wait for an available connection using Promise with timeout
    this.logger.debug(
      'LDAP connection pool full, waiting for available connection'
    );
    return new Promise<PooledConnection>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        const idx = this.waitingResolvers.indexOf(resolveWrapper);
        if (idx !== -1) this.waitingResolvers.splice(idx, 1);
        reject(new Error('LDAP connection pool timeout after 30s'));
      }, 30000);

      const resolveWrapper = (conn: PooledConnection) => {
        globalThis.clearTimeout(timeoutId);
        resolve(conn);
      };
      this.waitingResolvers.push(resolveWrapper);
    });
  }

  /**
   * Release a connection back to the pool
   * If there are waiting requests, hand off the connection directly
   */
  private releaseConnection(pooled: PooledConnection): void {
    // Check if connection has expired before reusing
    if (Date.now() - pooled.createdAt > this.connectionTtl) {
      const idx = this.connectionPool.indexOf(pooled);
      if (idx !== -1) this.connectionPool.splice(idx, 1);
      void pooled.client.unbind().catch(() => {});
      this.logger.debug('Released expired LDAP connection (discarded)');
      return;
    }

    // If there are waiting requests, give them the connection directly (O(1))
    if (this.waitingResolvers.length > 0) {
      const resolve = this.waitingResolvers.shift()!;
      // Connection stays in use, just transfer ownership
      this.logger.debug('Released LDAP connection to waiting request');
      resolve(pooled);
      return;
    }

    // No waiters, mark as available
    pooled.inUse = false;
    this.availableConnections.push(pooled);
    this.logger.debug('Released LDAP connection back to pool');
  }

  /**
   * Get a sorted signature for attribute list, using cache for performance
   */
  private getAttributeSignature(attributes: string[] | undefined): string {
    if (!attributes || attributes.length === 0) return '*';
    // Use array as-is for cache key (common patterns repeat)
    const key = attributes.join('|');
    let sig = this.attrSignatureCache.get(key);
    if (!sig) {
      sig = [...attributes].sort().join(',');
      this.attrSignatureCache.set(key, sig);
    }
    return sig;
  }

  /**
   * Generate cache key for LDAP search
   *
   * Every option that changes the answer belongs in here, or a search that
   * asked for more is served what a search that asked for less got: the
   * requested attributes above all, but also the ones that change the shape
   * of what comes back. `timeLimit` is deliberately absent — it bounds how
   * long the server may spend, not what it returns.
   */
  private getCacheKey(base: string, opts: SearchOptions): string {
    // Create a deterministic cache key from base DN and search options
    const sortedAttrs = this.getAttributeSignature(opts.attributes);
    const bufferAttrs = opts.explicitBufferAttributes?.length
      ? [...opts.explicitBufferAttributes].sort().join(',')
      : '-';
    const filterStr =
      typeof opts.filter === 'string'
        ? opts.filter
        : opts.filter
          ? opts.filter.toString()
          : '(objectClass=*)';
    return [
      base,
      opts.scope || 'sub',
      filterStr,
      sortedAttrs,
      bufferAttrs,
      opts.returnAttributeValues === false ? 'novalues' : 'values',
      opts.derefAliases ?? '-',
      String(opts.sizeLimit ?? '-'),
    ].join(CACHE_KEY_SEPARATOR);
  }

  /**
   * Drop every cached read of `dn`, and of everything below it.
   *
   * Called after each write, so the next read of what just changed goes to
   * the directory. Two things this does that a `key.startsWith(dn)` test did
   * not: it compares DNs the way the directory does (see {@link foldDn}), so
   * a write spelling a DN differently from the read that cached it still
   * drops it; and it drops the subtree, because `rename()` and `move()`
   * re-parent a whole branch in one operation — renaming an organization
   * changes the DN of every entry under it — leaving the cached reads of
   * those children filed under DNs that no longer exist. A leaf has nothing
   * below it and the extra test costs nothing.
   */
  invalidateCache(dn: string): void {
    if (!this.cacheEnabled) return;
    // Every write ends the epoch any read in flight started in, whether or
    // not this call finds an entry to drop: the read it overtook may not
    // have stored its own yet. See `cacheGeneration`.
    this.cacheGeneration++;
    const target = foldDn(dn);
    const descendantSuffix = `,${target}`;
    // Collect before deleting: dropping entries from the LRU while walking
    // its own key iterator is not something lru-cache promises to survive.
    const doomed: string[] = [];
    for (const key of this.searchCache.keys()) {
      const keyBase = foldDn(key.split(CACHE_KEY_SEPARATOR)[0]);
      if (keyBase === target || keyBase.endsWith(descendantSuffix))
        doomed.push(key);
    }
    for (const key of doomed) this.searchCache.delete(key);
  }

  /**
   * Drop every cached read holding a value that names `dn`, or an entry
   * below it.
   *
   * The directory mirrors some writes onto other entries than the one
   * written: the `memberof` overlay keeps each member's `memberOf` in step
   * with the group's `member` / `uniqueMember`, and `refint` rewrites or
   * removes the references to an entry renamed or deleted. Those entries'
   * cached reads are what {@link invalidateCache} cannot find, and they name
   * the entry written: the members of a group name it in their `memberOf`.
   * A member a write adds names it only once the write has landed; the
   * caller drops those by their own DN.
   *
   * Every attribute is looked at, not `memberOf` alone: which attributes an
   * overlay maintains is the deployment's configuration. A read naming `dn`
   * for another reason is dropped too, which costs a miss.
   */
  private invalidateReferences(dn: string): void {
    if (!this.cacheEnabled) return;
    this.cacheGeneration++;
    const target = foldDn(dn);
    const descendantSuffix = `,${target}`;
    const names = (value: unknown): boolean => {
      if (typeof value !== 'string') return false;
      const folded = foldDn(value);
      return folded === target || folded.endsWith(descendantSuffix);
    };
    const doomed: string[] = [];
    for (const [key, result] of this.searchCache.entries())
      if (
        result.searchEntries.some(entry =>
          Object.values(entry).some(value =>
            Array.isArray(value) ? value.some(names) : names(value)
          )
        )
      )
        doomed.push(key);
    for (const key of doomed) this.searchCache.delete(key);
  }

  /*
    LDAP search
   */
  /**
   * The directory as the server itself, with no request behind it.
   *
   * Every authorization plugin judges an operation by its request, and
   * judges nothing without one. Some work belongs to nobody in particular:
   * a startup task, a cron job, a uniqueness check, a referential-integrity
   * check. Those must see the
   * whole directory to be correct: a caller who cannot *read* `uid=jdoe`
   * must still not be handed it as a free identifier, and a reference to an
   * organization they cannot read is still a valid reference.
   *
   * Writes included, since a scheduled task writes: the examples above are
   * reads because that is where the ambiguity lives, not because a write
   * cannot belong to nobody.
   *
   * While a request is being served, an operation that names none is made
   * for it ({@link currentRequest}), so `ldap.search(…)` is judged as the
   * caller. These operations step out of the request instead: they are the
   * server's, whatever plugin serves the request — `authzDynamic` included.
   * Each use says why the work is the server's.
   *
   * Only those six step out: `system.readableBy` and `system.forRequest`
   * still judge the request they are given or find.
   */
  get system(): this {
    this.systemView ??= new Proxy(this, {
      get: (target, prop): unknown => {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function' || !SYSTEM_OPERATIONS.has(prop))
          return value;
        return (...args: unknown[]): unknown =>
          outsideRequest(() =>
            (value as (...a: unknown[]) => unknown).apply(target, args)
          );
      },
    });
    return this.systemView;
  }

  /** {@link system}, built once. */
  private systemView?: this;

  /**
   * Bind every directory operation to one request, so the authorization
   * hooks always see it. See {@link RequestBoundLdap}.
   */
  forRequest(req: Request): RequestBoundLdap {
    return {
      search: (options, base) => this.search(options, base ?? this.base, req),
      add: (dn, entry) => this.add(dn, entry, req),
      modify: (dn, changes, options) => this.modify(dn, changes, req, options),
      rename: (dn, newRdn) => this.rename(dn, newRdn, req),
      delete: dn => this.delete(dn, req),
    };
  }

  /**
   * Whether the caller of a request can read an entry.
   *
   * For a route that finds an entry as the server — by an attribute, across
   * branches — and then answers about it: an entry the caller cannot read
   * must get the answer an entry that is not there gets, or the route tells
   * them what the directory holds where they cannot read. Refused or
   * filtered out by an authorization plugin, the entry reads as absent.
   * Without a request, as for any operation, nobody judges.
   *
   * @param dn the entry
   * @param req the request whose caller asks
   * @returns whether a read of the entry, as that caller, finds it
   */
  async readableBy(dn: string, req?: Request): Promise<boolean> {
    req ??= currentRequest();
    if (!req) return true;
    try {
      const found = (await this.search(
        { paged: false, scope: 'base', attributes: ['1.1'] },
        dn,
        req
      )) as SearchResult;
      return (found.searchEntries?.length ?? 0) > 0;
    } catch (err) {
      if (
        isAuthzRefusal(err) ||
        (err as { statusCode?: number })?.statusCode === 403 ||
        extractLdapCode(err) === 32
      )
        return false;
      throw err;
    }
  }

  /**
   * Have the authorization plugins judge an operation, without making it.
   *
   * A route that looks in the directory before it writes — whether an entry
   * is there, which organization holds it, whether a pointer leads
   * somewhere — answers what it found, as the server, to whoever asked. A
   * caller who may not make the write then learns, one request at a time,
   * what the directory holds where they cannot read. Judged first, they get
   * the 403 the write itself would get, whether the entry is there or not.
   *
   * Only the hooks of the plugins with the `authz` role run, and what they
   * return is dropped: the operation, when it is made, runs every hook
   * again. Without a request in the arguments, the one being served is
   * judged, as for the operation itself; outside any, nobody judges.
   *
   * @param hook the request hook the operation launches
   * @param args what the operation hands that hook
   * @throws the refusal of the first authorization plugin refusing
   */
  async authorize<H extends AuthorizedHook>(
    hook: H,
    args: Parameters<NonNullable<Hooks[H]>>[0]
  ): Promise<void> {
    // The request being served, when none is named, as for the operation
    const given = [...(args as unknown[])];
    // Judged under the names the operation will give them
    if (hook === 'ldapaddrequest')
      await this.canonicalAttributes(given[1] as AttributesList);
    if (hook === 'ldapmodifyrequest')
      await this.canonicalChanges(given[1] as ModifyRequest);
    const at = AUTHORIZED_REQUEST_AT[hook];
    given[at] ??= currentRequest();
    // The DNs as the operation completes them before its hooks see them
    const [target, ...rest] = given;
    const judged: unknown[] =
      hook === 'ldapdeleterequest'
        ? [[target].flat().map(dn => this.setDn(String(dn))), ...rest]
        : [this.setDn(String(target)), ...rest];
    if (hook === 'ldaprenamerequest') judged[1] = this.setDn(String(judged[1]));
    const judges = (this.parent.hooks[hook] ?? []).filter(fn => {
      const owner = hookOwner(fn);
      return Boolean(
        owner &&
        this.parent.loadedPlugins[owner.plugin]?.roles?.includes('authz')
      );
    });
    await launchHooksChained(judges, judged as typeof args);
  }

  /**
   * Declare the object classes an entity gives the entries of its branch.
   *
   * An entry created by another tool may lack some of them, and a class it
   * lacks can forbid an attribute written here: the organization link of an
   * account made as a bare `inetOrgPerson` is refused by the directory. A
   * modify writing such an attribute adds the auxiliary class that allows
   * it, see {@link classRepair}.
   *
   * @param base branch holding the entity's entries
   * @param classes object classes the entity's schema declares; a schema
   * file may give a single one as a string
   * @param includeBase whether the base is itself one of the entries, as the
   * top organization is
   */
  declareObjectClasses(
    base: string,
    classes: string[] | string,
    includeBase = false
  ): void {
    const list = (Array.isArray(classes) ? classes : [classes]).filter(
      (name): name is string => typeof name === 'string' && name !== ''
    );
    if (!base || list.length === 0) return;
    // Keyed so that declaring again, as each new instance of an entity
    // does, adds nothing
    const key = JSON.stringify([
      normalizeDn(base),
      list.map(name => name.toLowerCase()).sort(),
      includeBase,
    ]);
    this.declaredClasses.set(key, { base, classes: list, includeBase });
  }

  /**
   * The classes declared for the branch holding a DN. Several entities may
   * share a branch — the shipped `users`, `posixAccounts` and
   * `sshPublicKeys` schemas all live in `ou=users` — so every declaration at
   * the deepest matching base counts.
   */
  private declaredFor(dn: string): string[] {
    let depth = 0;
    let classes: string[] = [];
    for (const declared of this.declaredClasses.values()) {
      if (!isDnInBranch(dn, declared.base)) continue;
      const base = normalizeDn(declared.base);
      if (!declared.includeBase && normalizeDn(dn) === base) continue;
      const here = base.split(',').length;
      if (here > depth) {
        depth = here;
        classes = [];
      }
      if (here === depth) classes.push(...declared.classes);
    }
    const seen = new Set<string>();
    return classes.filter(name => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Log a class problem of an entry once, not on every write to it: nothing
   * an administrator can do stops a sync job from touching it again.
   */
  private warnOnce(message: string): void {
    if (this.classWarnings.has(message)) return;
    this.classWarnings.set(message, true);
    this.logger.warn(message);
  }

  /**
   * The auxiliary classes a modify needs added: for each attribute it writes
   * that the entry's classes do not allow, a class declared for its branch
   * or by the writer that allows it, provided the entry holds or receives
   * that class's mandatory attributes once the change is applied.
   *
   * Only what the write needs is added. Entities sharing a branch declare
   * classes that are not all meant for every entry: `shadowAccount` is not
   * something every account should be given because it sits in `ou=users`.
   * And a write that the directory would have accepted is never changed.
   *
   * Nothing is added when the change names `objectClass` itself, and a
   * schema or entry that cannot be read skips the repair.
   *
   * @param dn entry being modified
   * @param changes the modification, after the hooks
   * @param extra classes the writer declares, see {@link ModifyOptions}
   * @returns names of the classes to add, or `allowed` when the entry's
   * classes take the change as it is
   */
  private async classRepair(
    dn: string,
    changes: ModifyRequest,
    extra: string[] = []
  ): Promise<string[] | 'allowed'> {
    if (this.config.ldap_flat_auto_repair === false) return [];
    const declared = [...this.declaredFor(dn)];
    for (const name of extra)
      if (!declared.some(d => d.toLowerCase() === name.toLowerCase()))
        declared.push(name);
    if (declared.length === 0) return [];
    const deleted = Array.isArray(changes.delete)
      ? changes.delete
      : Object.entries(changes.delete || {})
          // Deleting some values leaves the attribute in place.
          .filter(
            ([, value]) => !value || (Array.isArray(value) && !value.length)
          )
          .map(([name]) => name);
    const named = [
      ...Object.keys(changes.add || {}),
      ...Object.keys(changes.replace || {}),
      ...(Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete || {})),
    ];
    if (named.some(name => name.toLowerCase() === 'objectclass')) return [];

    let index: SchemaIndex;
    try {
      index = await this.schemaIndex();
      this.schemaUnavailable = false;
    } catch (err) {
      if (!this.schemaUnavailable)
        this.logger.warn(
          `Object classes are not repaired: the directory schema could not be read (${String(err)})`
        );
      this.schemaUnavailable = true;
      return [];
    }

    const attributeKey = (name: string): string =>
      index.getAttributeType(name)?.oid ?? name.toLowerCase();
    const allowedBy = (classes: string[]): Set<string> => {
      const { must, may } = index.resolveAttributes(classes);
      return new Set([...must, ...may].map(attributeKey));
    };
    // ldapts answers every attribute asked for, an absent one as empty; and
    // an empty `replace` removes the attribute.
    const valued = (list?: Record<string, unknown>): string[] =>
      Object.entries(list || {})
        .filter(([, value]) =>
          Array.isArray(value)
            ? value.length > 0
            : value !== undefined && value !== null && value !== ''
        )
        .map(([name]) => name);
    const written = [...valued(changes.add), ...valued(changes.replace)];

    // Declared auxiliary classes that could carry something this change
    // writes. None: the entry is not read at all.
    const auxiliaries = declared.filter(name => {
      const oc = index.getObjectClass(name);
      if (oc?.kind !== 'AUXILIARY') return false;
      const allows = allowedBy([name]);
      return written.some(attribute => allows.has(attributeKey(attribute)));
    });
    if (auxiliaries.length === 0) return [];

    let entry: AttributesList | undefined;
    try {
      const result = (await this.system.search(
        {
          paged: false,
          scope: 'base',
          attributes: [
            'objectClass',
            ...index.resolveAttributes(auxiliaries).must,
          ],
        },
        dn
      )) as SearchResult;
      entry = result.searchEntries[0] as AttributesList | undefined;
    } catch {
      return [];
    }
    if (!entry) return [];

    const raw = entry.objectClass ?? entry.objectclass;
    const present = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const allowed = allowedBy(present);
    let needed = written.filter(
      attribute =>
        index.getAttributeType(attribute) &&
        !allowed.has(attributeKey(attribute))
    );
    if (needed.length === 0) return 'allowed';

    const gone = new Set(deleted.map(attributeKey));
    const held = new Set(
      [
        ...valued(entry).filter(name => !gone.has(attributeKey(name))),
        ...written,
      ].map(attributeKey)
    );
    const { auxiliary, structural } = index.missingClasses(declared, present);
    const added: string[] = [];
    for (const oc of auxiliary) {
      const name = oc.names[0] ?? oc.oid;
      const allows = allowedBy([name]);
      const covers = needed.filter(attribute =>
        allows.has(attributeKey(attribute))
      );
      if (covers.length === 0) continue;
      const lacking = index
        .resolveAttributes([name])
        .must.filter(attribute => !held.has(attributeKey(attribute)));
      if (lacking.length > 0) {
        this.warnOnce(
          `${dn} needs ${name} for ${covers.join(', ')}, and cannot be given it without ${lacking.join(', ')}`
        );
        continue;
      }
      added.push(name);
      needed = needed.filter(attribute => !covers.includes(attribute));
    }
    const blocking = structural.filter(name => {
      const allows = allowedBy([name]);
      return needed.some(attribute => allows.has(attributeKey(attribute)));
    });
    if (blocking.length > 0)
      this.warnOnce(
        `${dn} cannot hold ${needed.join(', ')}: its schema declares ${blocking.join(', ')}, a structural class an existing entry cannot be given`
      );
    if (added.length > 0)
      this.logger.info(
        `${dn}: adding ${added.join(', ')}, which the change needs and its schema declares`
      );
    return added;
  }

  /**
   * DN of the subschema entry the root DSE advertises, or the conventional
   * `cn=Subschema` when it advertises none.
   */
  async subschemaDn(): Promise<string> {
    try {
      const result = (await this.system.search(
        {
          paged: false,
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: ['subschemaSubentry'],
        },
        ''
      )) as SearchResult;
      const value = result.searchEntries[0]?.subschemaSubentry;
      const dn = Array.isArray(value) ? value[0] : value;
      if (dn) return String(dn);
    } catch (err) {
      this.logger.warn(
        `Unable to read subschemaSubentry from root DSE: ${String(err)}`
      );
    }
    return 'cn=Subschema';
  }

  /**
   * The directory schema, kept for `--ldap-raw-schema-cache-ttl`: it is
   * large and changes rarely. The raw browser and the object class repair
   * share it, and concurrent callers share a single read.
   *
   * @returns indexed schema
   */
  async schemaIndex(): Promise<SchemaIndex> {
    const maxAge = (this.config.ldap_raw_schema_cache_ttl ?? 3600) * 1000;
    if (this.schemaCache && Date.now() - this.schemaCache.fetchedAt < maxAge)
      return this.schemaCache.index;
    if (this.schemaLoading) return this.schemaLoading;

    this.schemaLoading = (async (): Promise<SchemaIndex> => {
      const dn = await this.subschemaDn();
      const result = (await this.system
        .search(
          {
            paged: false,
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: [
              'objectClasses',
              'attributeTypes',
              'ldapSyntaxes',
              'matchingRules',
            ],
          },
          dn
        )
        .catch((err: unknown) => {
          if ((err as { code?: number })?.code === 32)
            throw new NotFoundError(`Subschema entry ${dn} not found`);
          throw err;
        })) as SearchResult;
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
      return await this.schemaLoading;
    } finally {
      this.schemaLoading = undefined;
    }
  }

  /**
   * Say how this server spells attribute names: a schema loaded by a plugin
   * names its attributes as the plugins compare them. The first spelling of
   * a name wins.
   *
   * @param names attribute names
   */
  knowAttributeNames(names: Iterable<string>): void {
    for (const name of names) {
      if (!name || name.includes(';')) continue;
      const key = name.toLowerCase();
      if (!this.spellings.has(key)) this.spellings.set(key, name);
      // A plugin comparing with the other spelling, or the other name of
      // the type, would miss the writes. The aliases a deployment's own
      // schema declares are not known here
      const type = (knownAttributeName(name) ?? name).toLowerCase();
      const known = this.spelledTypes.get(type);
      if (known === undefined) this.spelledTypes.set(type, name);
      else if (known !== name)
        this.logger.warn(
          `Attribute "${name}" is also named "${known}" in the configuration ` +
            'or a schema: plugins comparing with one name miss the other'
        );
    }
  }

  /**
   * Name each attribute of a write as this server does, in place.
   *
   * The directory takes `MAIL`, `rfc822Mailbox` and `0.9.2342.19200300.100.1.3`
   * for `mail`, while the authorization plugins and the hooks look for
   * `mail`: a write naming the organization link by its OID was judged as
   * if it left the link alone. Each name is resolved through the directory
   * schema — case, aliases, OIDs — and written as the configuration or a
   * loaded schema spells it, or as the directory declares it first.
   *
   * An option names a value of its own (`member;lang-en` is not `member` to
   * the hooks guarding `member`), and is refused, `;binary` aside. Two names
   * for one attribute in one part of a write are refused too: on a modify
   * the directory applies both, and only one would have been judged.
   *
   * Without the schema, the case is still set, and a name given as an OID,
   * which nothing here could resolve, is refused.
   *
   * @param entry attributes of an add, or one part of a modify
   * @throws BadRequestError on an option, or on one attribute named twice
   */
  async canonicalAttributes(entry: AttributesList | undefined): Promise<void> {
    if (!entry) return;
    const keys = Object.keys(entry);
    const names = await this.canonicalNames(keys);
    if (keys.every((key, i) => key === names[i])) return;
    const values = keys.map(key => entry[key]);
    for (const key of keys) delete entry[key];
    names.forEach((name, i) => (entry[name] = values[i]));
  }

  /**
   * {@link canonicalAttributes} for every part of a modify, in place.
   *
   * @param changes the modify
   * @throws BadRequestError as {@link canonicalAttributes}
   */
  async canonicalChanges(changes: ModifyRequest | undefined): Promise<void> {
    if (!changes) return;
    await this.canonicalAttributes(changes.add);
    await this.canonicalAttributes(changes.replace);
    if (Array.isArray(changes.delete))
      changes.delete = await this.canonicalNames(changes.delete);
    else await this.canonicalAttributes(changes.delete);
  }

  /**
   * The names of one part of a write, as {@link canonicalAttributes} writes
   * them.
   */
  private async canonicalNames(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return keys;
    let index: SchemaIndex | undefined;
    try {
      index = await this.schemaIndex();
      this.schemaUnavailable = false;
    } catch (err) {
      // One warning for both its uses, this and the class repair
      if (!this.schemaUnavailable)
        this.logger.warn(
          `The directory schema could not be read (${String(err)}): ` +
            'attribute names are resolved from the standard types only, a ' +
            'name given as another OID is refused, and object classes are ' +
            'not repaired'
        );
      this.schemaUnavailable = true;
    }
    const seen = new Map<string, string>();
    return keys.map(key => {
      const name = this.canonicalName(key, index);
      const same = seen.get(name.toLowerCase());
      if (same !== undefined)
        throw new BadRequestError(
          `"${same}" and "${key}" name the same attribute`
        );
      seen.set(name.toLowerCase(), key);
      return name;
    });
  }

  /**
   * One attribute description, named as this server does.
   *
   * @param key the name as written, options included
   * @param index the directory schema, when it could be read
   */
  private canonicalName(key: string, index?: SchemaIndex): string {
    const [written, ...options] = key.split(';');
    // `OID.2.5.4.3`, the LDAPv2 spelling of an OID
    const base = written.replace(/^oid\./i, '');
    const option = options.find(o => o.toLowerCase() !== 'binary');
    if (option !== undefined)
      throw new BadRequestError(
        `Attribute option "${option}" of "${key}" is not accepted`
      );
    const type = index?.getAttributeType(base);
    // Without the schema, the names and OIDs this server knows of itself
    const builtIn = index ? undefined : knownAttributeName(base);
    if (!index && !builtIn && /^\d+(\.\d+)+$/.test(base))
      throw new BadRequestError(
        `Attribute "${key}" cannot be named by its OID here`
      );
    const known = type
      ? [...type.names, type.oid]
      : [base, ...(builtIn ? [builtIn] : [])];
    const name =
      known.map(n => this.spellings.get(n.toLowerCase())).find(Boolean) ??
      type?.names[0] ??
      builtIn ??
      base;
    return options.length ? `${name};binary` : name;
  }

  /**
   * Hand a search result to `ldapsearchfilter`, which may drop entries the
   * caller is not allowed to see.
   *
   * Applied on every return path of `search`, and deliberately after the
   * cache: `ldapsearchresult` fires before caching and knows no request, so
   * what it removed for one caller would be served to the next. A paginated
   * search is filtered chunk by chunk, as it is consumed.
   */
  private filterForCaller(
    value: SearchResult | AsyncGenerator<SearchResult>,
    req?: Request,
    opts?: SearchOptions
  ): SearchResult | AsyncGenerator<SearchResult> | Promise<SearchResult> {
    if (!this.parent.hooks.ldapsearchfilter) return value;
    const hook = this.parent.hooks.ldapsearchfilter;
    const one = async (chunk: SearchResult): Promise<SearchResult> => {
      const [filtered] = await launchHooksChained(hook, [chunk, req, opts]);
      // A subscriber that returns nothing must not turn the answer into one.
      return filtered ?? chunk;
    };
    if (
      typeof (value as AsyncGenerator<SearchResult>)[Symbol.asyncIterator] ===
      'function'
    ) {
      const source = value as AsyncGenerator<SearchResult>;
      return (async function* (): AsyncGenerator<SearchResult> {
        for await (const chunk of source) yield await one(chunk);
      })();
    }
    return one(value as SearchResult);
  }

  async search(
    options: SearchOptions,
    base: string = this.base,
    req?: Request
  ): Promise<SearchResult | AsyncGenerator<SearchResult>> {
    req ??= currentRequest();
    let opts = {
      ...defaultSearchOptions,
      ...options,
    };
    opts = await launchHooksChained(this.parent.hooks.ldapsearchopts, opts);
    [base, opts] = await launchHooksChained(
      this.parent.hooks.ldapsearchrequest,
      [base, opts, req]
    );

    // Cache non-paginated, base-scope searches only: they are the common
    // attribute lookups, and one entry is small enough to keep.
    //
    // The lookup sits after the `ldapsearchrequest` hooks on purpose. The
    // authorization plugins refuse by throwing from them, so a cache hit is
    // only ever reached by a request already allowed to read `base`, and the
    // key is built from the base and options those hooks settled on.
    const cacheable = this.cacheEnabled && !opts.paged && opts.scope === 'base';
    const cacheKey = cacheable ? this.getCacheKey(base, opts) : '';
    // The write count this read starts at: a write landing between here and
    // the store below would leave what comes back describing a state that no
    // longer holds, and `invalidateCache` would find nothing to drop. See
    // `cacheGeneration`.
    const generation = this.cacheGeneration;
    if (cacheable) {
      const cached = this.searchCache.get(cacheKey);
      if (cached) {
        this.logger.debug(`LDAP search cache hit: ${digestKey(cacheKey)}`);
        return this.filterForCaller(cloneSearchResult(cached), req, opts);
      }
    }

    // Acquire connection from pool
    const pooled = await this.acquireConnection();
    try {
      let res = opts.paged
        ? dropSelectorsPaged(pooled.client.searchPaginated(base, opts))
        : pooled.client.search(base, opts).then(dropSelectors);
      res = (await launchHooksChained(
        this.parent.hooks.ldapsearchresult,
        res
      )) as typeof res;

      // Cache non-paginated, base-scope search results.
      //
      // `launchHooksChained` awaits whatever each hook returns, so by here
      // `res` is the resolved result of a non-paginated search and never a
      // Promise: the `res instanceof Promise` guard that used to stand here
      // could not be true, and nothing was ever cached (#166). What the
      // hooks see is untouched — the chain above is still handed the
      // unawaited value the driver returned, in the same place as before.
      //
      // A search that fails — noSuchObject on a DN that is not there — threw
      // out of the chain above and never reaches this line, so a missing
      // entry is never cached as missing.
      if (cacheable) {
        const result = res as unknown as SearchResult;
        // A write that landed while this read was in flight makes what came
        // back describe the directory as it was before that write, and there
        // is nothing left to drop it: the write's `invalidateCache` ran when
        // this entry did not exist yet. Storing it now would serve the state
        // it replaced for a whole TTL, so it is answered, not kept.
        if (generation === this.cacheGeneration) {
          this.searchCache.set(cacheKey, cloneSearchResult(result));
          this.logger.debug(`LDAP search cached: ${digestKey(cacheKey)}`);
        } else {
          this.logger.debug(
            `LDAP search not cached, a write overtook it: ${digestKey(cacheKey)}`
          );
        }
        return this.filterForCaller(result, req, opts);
      }

      // For paginated searches, return a wrapped generator that releases connection when done
      if (opts.paged) {
        return this.filterForCaller(
          this.wrapPaginatedSearch(res as AsyncGenerator<SearchResult>, pooled),
          req,
          opts
        ) as AsyncGenerator<SearchResult>;
      }

      return this.filterForCaller(res as unknown as SearchResult, req, opts);
    } finally {
      // For non-paginated searches, release connection immediately
      if (!opts.paged) {
        this.releaseConnection(pooled);
      }
    }
  }

  /**
   * Wrap paginated search to ensure connection is released when done
   */
  private async *wrapPaginatedSearch(
    generator: AsyncGenerator<SearchResult>,
    pooled: PooledConnection
  ): AsyncGenerator<SearchResult> {
    try {
      for await (const result of generator) {
        yield result;
      }
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /*
    LDAP add
   */
  async add(
    dn: string,
    entry: AttributesList,
    req?: Request
  ): Promise<boolean> {
    req ??= currentRequest();
    dn = this.setDn(dn);
    await this.canonicalAttributes(entry);
    if (
      (!entry.objectClass || entry.objectClass.length === 0) &&
      this.config.user_class
    ) {
      entry.objectClass = this.config.user_class;
    }
    // Convert Buffer/Buffer[] values to string/string[]
    const sanitizedEntry: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (Buffer.isBuffer(value)) {
        sanitizedEntry[key] = value.toString();
      } else if (
        Array.isArray(value) &&
        value.length > 0 &&
        Buffer.isBuffer(value[0])
      ) {
        sanitizedEntry[key] = (value as Buffer[]).map(v => v.toString());
      } else {
        sanitizedEntry[key] = value as string | string[];
      }
    }
    [dn, entry] = (await launchHooksChained(this.parent.hooks.ldapaddrequest, [
      dn,
      sanitizedEntry,
      req,
    ])) as [string, typeof entry, Request?];

    const members = membersNamed(entry);

    // Convert to Attribute objects
    const attributes: Attribute[] = [];
    for (const [key, value] of Object.entries(entry)) {
      assertHasValue(key, value);
      const values = (Array.isArray(value) ? value : [value]) as
        | string[]
        | Buffer[];
      attributes.push(
        new Attribute({
          type: key,
          values,
        })
      );
    }

    const pooled = await this.acquireConnection();
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and `cacheGeneration` keeps a read the write
      // overtook from putting it back.
      this.invalidateCache(dn);
      // A group created with members changes their `memberOf`
      for (const member of members) this.invalidateCache(member);
      await pooled.client.add(dn, attributes);
      // Drop any cached read of this DN.
      //
      // Not to lift a negative result: a base-scope read of a DN that is not
      // there throws and caches nothing, and an add on a DN that *is* there
      // is refused by the directory. What it covers is the entry read and
      // cached here, then deleted by something else — another replica, LSC,
      // ldapmodify — and re-created through this call, where the cache would
      // otherwise keep answering the entry that used to carry this DN.
      this.invalidateCache(dn);
      for (const member of members) this.invalidateCache(member);
      void launchHooks(
        this.parent.hooks.ldapadddone,
        [dn, entry],
        changeContext(req)
      );
    } catch (error) {
      throw ldapAddError(dn, error);
    } finally {
      this.releaseConnection(pooled);
    }
    // After the finally, so no pooled connection is held while subscribers
    // run; launchHooks logs their errors, the add having succeeded
    await launchHooks(
      this.parent.hooks.ldapaddafter,
      [dn, entry],
      changeContext(req)
    );
    return true;
  }

  /*
    LDAP modify
   */
  async modify(
    dn: string,
    changes: ModifyRequest,
    req?: Request,
    options: ModifyOptions = {}
  ): Promise<boolean> {
    req ??= currentRequest();
    const op: number = this.opNumber();
    const done: Promise<void>[] = [];
    try {
      return await runOperation(op, () =>
        this.applyModify(dn, changes, req, options, op, done)
      );
    } finally {
      this.endOperation(done, this.parent.hooks.ldapmodifyend, op);
    }
  }

  private async applyModify(
    dn: string,
    changes: ModifyRequest,
    req: Request | undefined,
    options: ModifyOptions,
    op: number,
    done: Promise<void>[]
  ): Promise<boolean> {
    dn = this.setDn(dn);
    const ldapChanges: Change[] = [];
    await this.canonicalChanges(changes);
    [dn, changes] = await launchHooksChained(
      this.parent.hooks.ldapmodifyrequest,
      [dn, changes, op, req]
    );
    if (changes.add) {
      for (const [key, value] of Object.entries(changes.add)) {
        assertHasValue(key, value);
        ldapChanges.push(
          new Change({
            operation: 'add',
            modification: new Attribute({
              type: key,
              values: Array.isArray(value) ? value : [value as string],
            }),
          })
        );
      }
    }
    if (changes.replace) {
      for (const [key, value] of Object.entries(changes.replace)) {
        ldapChanges.push(
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: key,
              values: Array.isArray(value) ? value : [value as string],
            }),
          })
        );
      }
    }

    if (changes.delete) {
      if (Array.isArray(changes.delete)) {
        for (const attr of changes.delete) {
          if (attr)
            ldapChanges.push(
              new Change({
                operation: 'delete',
                modification: new Attribute({
                  type: attr,
                  values: [],
                }),
              })
            );
        }
      } else {
        for (const [key, value] of Object.entries(changes.delete)) {
          const change = new Change({
            operation: 'delete',
            modification: value
              ? new Attribute({
                  type: key,
                  values: Array.isArray(value)
                    ? (value as string[])
                    : [value as string],
                })
              : new Attribute({ type: key }),
          });
          ldapChanges.push(change);
        }
      }
    }
    // A change of a group's members changes their `memberOf`: those it names,
    // and those a replace or a delete of every value removes, which only
    // their cached reads still tie to the group.
    const membershipChanged = [changes.add, changes.replace, changes.delete]
      .flatMap(part =>
        Array.isArray(part) ? part : Object.keys((part as object) ?? {})
      )
      .some(isMembershipAttribute);
    const invalidate = (): void => {
      this.invalidateCache(dn);
      if (!membershipChanged) return;
      this.invalidateReferences(dn);
      for (const part of [changes.add, changes.replace, changes.delete])
        for (const member of membersNamed(Array.isArray(part) ? {} : part))
          this.invalidateCache(member);
    };
    if (ldapChanges.length !== 0) {
      const controls = options.permissive
        ? [new Control(PERMISSIVE_MODIFY, { critical: false })]
        : undefined;
      const send = async (): Promise<void> => {
        const pooled = await this.acquireConnection();
        try {
          await pooled.client.modify(dn, ldapChanges, controls);
        } finally {
          this.releaseConnection(pooled);
        }
      };
      try {
        // Dropped before the write is issued as well as after it lands. The
        // directory commits somewhere inside this `await`, and the invalidation
        // below runs only once the answer has come back: a read landing in that
        // round trip would find the entry still cached and answer what it held
        // before the write. Dropping it early costs a miss if the write then
        // fails, which is harmless, and `cacheGeneration` keeps a read the write
        // overtook from putting it back.
        invalidate();
        try {
          await send();
        } catch (error) {
          // Repaired only once the directory refuses the classes (65), so a
          // write it takes costs no read. The connection is given back before
          // the repair reads: holding it meanwhile could exhaust the pool.
          if (extractLdapCode(error) !== 65) throw error;
          const repair = await this.classRepair(
            dn,
            changes,
            options.declaredClasses
          );
          // `allowed`: a writer gave the entry its classes after the refusal,
          // so the change is sent again as it is
          if (repair !== 'allowed' && repair.length === 0) throw error;
          const repairChange =
            repair === 'allowed'
              ? undefined
              : new Change({
                  operation: 'add',
                  modification: new Attribute({
                    type: 'objectClass',
                    values: repair,
                  }),
                });
          if (repairChange) ldapChanges.push(repairChange);
          // The repair's read may have cached the entry again
          this.invalidateCache(dn);
          try {
            await send();
          } catch (retry) {
            // A writer in between may have given it the class already, and
            // adding it again is refused (20). What the repair wanted is then
            // there.
            if (!repairChange || extractLdapCode(retry) !== 20) throw retry;
            ldapChanges.splice(ldapChanges.indexOf(repairChange), 1);
            await send();
          }
        }
        invalidate();
        done.push(
          launchHooks(
            this.parent.hooks.ldapmodifydone,
            [dn, changes, op],
            options.context ?? changeContext(req)
          )
        );
        return true;
      } catch (error) {
        this.logger.warn(
          `Changes that failed: ${dn}, ${JSON.stringify(ldapChanges)}`
        );
        throw ldapModifyError(dn, error);
      }
    } else {
      // Two different things end up here, and only one of them is routine.
      //
      // A caller that asked for nothing: a SCIM PATCH whose operations all
      // turn out to be no-ops still comes through so the authorization hooks
      // run, and an empty modify touches the directory not at all.
      //
      // A caller that asked for something and got nothing emitted: every
      // change it named was dropped while building the request — an array
      // `delete` holding only empty strings, for instance. Nothing reaches
      // the directory and the call still answers, so a translation bug
      // upstream is invisible from the outside. That is worth a line someone
      // will see.
      const asked =
        Object.keys(changes.add || {}).length > 0 ||
        Object.keys(changes.replace || {}).length > 0 ||
        (Array.isArray(changes.delete)
          ? changes.delete.length > 0
          : Object.keys(changes.delete || {}).length > 0);
      if (asked) {
        this.logger.warn(
          `Modify on ${dn} asked for changes but emitted none; nothing was written`
        );
      } else {
        this.logger.debug(`Modify on ${dn} had nothing to apply`);
      }
      done.push(
        launchHooks(
          this.parent.hooks.ldapmodifydone,
          [dn, {}, op],
          options.context ?? changeContext(req)
        )
      );
      return false;
    }
  }

  async rename(dn: string, newRdn: string, req?: Request): Promise<boolean> {
    req ??= currentRequest();
    dn = this.setDn(dn);
    newRdn = this.setDn(newRdn);
    // The directory writes the values of the new RDN on the entry, where no
    // check of a write sees them: `cn=x+twakeDepartmentLink=…` linked a
    // group past the move check. One value, of the attribute the entry is
    // already named by
    const named = rdnTypes(dn);
    const renamed = rdnTypes(newRdn);
    if (renamed.length !== 1 || !named.includes(renamed[0]))
      throw new BadRequestError(
        `${newRdn}: an entry is renamed by one value of the attribute it is named by`
      );
    const op: number = this.opNumber();
    const done: Promise<void>[] = [];
    try {
      return await runOperation(op, () =>
        this.applyRename(dn, newRdn, req, done)
      );
    } finally {
      this.endOperation(done, this.parent.hooks.ldaprenameend, op);
    }
  }

  private async applyRename(
    dn: string,
    newRdn: string,
    req: Request | undefined,
    done: Promise<void>[]
  ): Promise<boolean> {
    [dn, newRdn] = await launchHooksChained(
      this.parent.hooks.ldaprenamerequest,
      [dn, newRdn, req]
    );
    const pooled = await this.acquireConnection();
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and `cacheGeneration` keeps a read the write
      // overtook from putting it back.
      this.invalidateCache(dn);
      this.invalidateCache(newRdn);
      this.invalidateReferences(dn);
      await pooled.client.modifyDN(dn, newRdn);
      // Invalidate both ends. A base-scope read of the old DN would
      // otherwise keep answering the entry that is no longer there, and a
      // read cached under the new DN — of whatever used to carry it — would
      // hide the entry that just took its place. `invalidateCache` drops the
      // subtree too: renaming a container moves every DN under it. And the
      // directory rewrites what named the old DN — the members' `memberOf`
      // of a renamed group, the references `refint` follows.
      this.invalidateCache(dn);
      this.invalidateCache(newRdn);
      this.invalidateReferences(dn);
      done.push(
        launchHooks(
          this.parent.hooks.ldaprenamedone,
          [dn, newRdn],
          changeContext(req)
        )
      );
      return true;
    } catch (error) {
      throw ldapRenameError('LDAP rename error', dn, newRdn, error);
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /**
   * Move an entry to a new location (different parent)
   * Uses LDAP modifyDN with full DN to change both RDN and parent
   *
   * Not judged, request or not: a move is the server's, made for a write
   * already judged — the trash turning a delete into one. A route moving an
   * entry for its caller uses {@link rename}, which is judged.
   *
   * Note: ldapts provides a high-level API that accepts a full DN as the second parameter,
   * unlike the standard LDAP modifyDN which expects (newRDN, deleteOldRDN, newSuperior).
   * ldapts automatically parses the full DN and extracts the newRDN and newSuperior components
   * before sending the proper LDAP modifyDN request to the server.
   *
   * @param dn - Current DN (e.g., "uid=user1,ou=users,dc=example,dc=com")
   * @param newDn - Full new DN (e.g., "uid=user1,ou=trash,dc=example,dc=com")
   *                ldapts will extract newRDN="uid=user1" and newSuperior="ou=trash,dc=example,dc=com"
   * @param req - Request behind the move, when there is one
   */
  async move(dn: string, newDn: string, req?: Request): Promise<boolean> {
    req ??= currentRequest();
    dn = this.setDn(dn);
    newDn = this.setDn(newDn);
    const pooled = await this.acquireConnection();
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and `cacheGeneration` keeps a read the write
      // overtook from putting it back.
      this.invalidateCache(dn);
      this.invalidateCache(newDn);
      this.invalidateReferences(dn);
      await pooled.client.modifyDN(dn, newDn);
      // Invalidate both ends — see rename() above for why both matter.
      this.invalidateCache(dn);
      this.invalidateCache(newDn);
      this.invalidateReferences(dn);
      // A move is a modifyDN, so it is a rename: the plugins that watch a
      // rename watch a move, and the two caches that outlive the search cache
      // (the authz group cache, the identity → DN resolution cache) are
      // dropped by the same hook. `ldaprenamerequest` is deliberately not
      // launched: it is an authorization hook, and this write has already
      // been judged by the `ldap*request` hook of whatever drove it —
      // re-running it here would judge the same write twice. Outside the
      // operation a request hook may have moved it from (the trash moves
      // from ldapdeleterequest): this move is not that write.
      void outsideOperation(() =>
        launchHooks(
          this.parent.hooks.ldaprenamedone,
          [dn, newDn],
          changeContext(req)
        )
      );
      this.logger.debug(`LDAP move: ${dn} -> ${newDn}`);
      return true;
    } catch (error) {
      throw ldapRenameError('LDAP move error', dn, newDn, error);
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /*
    LDAP delete
   */
  async delete(
    dn: string | string[],
    req?: Request,
    options: Pick<ModifyOptions, 'context'> = {}
  ): Promise<boolean> {
    req ??= currentRequest();
    const requested = (Array.isArray(dn) ? dn : [dn]).map(d => this.setDn(d));
    const op: number = this.opNumber();
    const done: Promise<void>[] = [];
    try {
      return await runOperation(op, () =>
        this.applyDelete(requested, req, options, done)
      );
    } finally {
      this.endOperation(done, this.parent?.hooks.ldapdeleteend, op);
    }
  }

  private async applyDelete(
    dn: string | string[],
    req: Request | undefined,
    options: Pick<ModifyOptions, 'context'>,
    done: Promise<void>[]
  ): Promise<boolean> {
    [dn] = (await launchHooksChained(this.parent?.hooks.ldapdeleterequest, [
      dn,
      req,
    ])) as [string | string[], Request?];

    const pooled = await this.acquireConnection();
    try {
      for (const entry of dn) {
        try {
          // Dropped before the write is issued as well as after it lands. The
          // directory commits somewhere inside this `await`, and the invalidation
          // below runs only once the answer has come back: a read landing in that
          // round trip would find the entry still cached and answer what it held
          // before the write. Dropping it early costs a miss if the write then
          // fails, which is harmless, and `cacheGeneration` keeps a read the write
          // overtook from putting it back.
          this.invalidateCache(entry);
          this.invalidateReferences(entry);
          await pooled.client.del(entry);
          // Invalidate cache for this DN, and for what named it: a deleted
          // group leaves its members' `memberOf`
          this.invalidateCache(entry);
          this.invalidateReferences(entry);
        } catch (error) {
          const code = extractLdapCode(error);
          throw code === 32
            ? withCode(new NotFoundError(`Entry ${entry} not found`), code)
            : ldapError(`LDAP delete error`, error);
        }
        done.push(
          launchHooks(
            this.parent.hooks.ldapdeletedone,
            entry,
            options.context ?? changeContext(req)
          )
        );
      }
      return true;
    } finally {
      this.releaseConnection(pooled);
    }
  }

  private setDn(dn: string): string {
    if (!/=/.test(dn)) {
      dn = `${this.config.ldap_user_main_attribute as string}=${escapeDnValue(dn)},${this.base}`;
    } else if (!/,/.test(dn)) {
      dn += `,${this.base}`;
    }
    return dn;
  }

  /**
   * Launch the "end" hooks of a write once its "done" hooks have returned,
   * whatever became of it: written, refused by a request hook, taken out of
   * the request by one, or failed in the directory, with its operation
   * number. A plugin keeping state from a request hook to a done one, keyed
   * by `currentOperation()`, drops there what no done hook took.
   */
  private endOperation(
    done: Promise<void>[],
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    hooks: Function[] | undefined,
    ...args: unknown[]
  ): void {
    if (!hooks?.length) return;
    void Promise.all(done).then(() => launchHooks(hooks, ...args));
  }

  opNumber(): number {
    return this.parent.operationSequence++;
  }
}

export default ldapActions;
