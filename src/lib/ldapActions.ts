/**
 * LDAP low-level library
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { createHash } from 'node:crypto';

import type { Request } from 'express';
import { Client, Attribute, Change } from 'ldapts';
import type { ClientOptions, SearchResult, SearchOptions } from 'ldapts';
import type winston from 'winston';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';

import { type Config } from '../config/args';
import { type DM } from '../bin';

import { escapeDnValue, launchHooks, launchHooksChained } from './utils';
import { changeContext } from './changeContext';
import { ConflictError } from './errors';

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

/**
 * The directory as seen by one HTTP request.
 *
 * `ldapActions`'s own methods take the request as a trailing optional
 * argument, and the authorization plugins hook `ldap*request` and skip every
 * check when it is missing — so omitting it is an authorization bypass that
 * fails silently rather than loudly. Three shipped in the SCIM plugin alone.
 *
 * These methods take no request parameter: it is captured once by
 * `ldapActions.forRequest()`, and forgetting it stops being expressible.
 * Request handlers should bind once and use this; the unbound methods remain
 * for work that genuinely belongs to no request, such as startup and cron
 * tasks, where passing nothing is the deliberate answer.
 */
export interface RequestBoundLdap {
  search(
    options: SearchOptions,
    base?: string
  ): Promise<SearchResult | AsyncGenerator<SearchResult>>;
  add(dn: string, entry: AttributesList): Promise<boolean>;
  modify(dn: string, changes: ModifyRequest): Promise<boolean>;
  rename(dn: string, newRdn: string): Promise<boolean>;
  delete(dn: string | string[]): Promise<boolean>;
}

// modify
export interface ModifyRequest {
  add?: AttributesList;
  replace?: AttributesList;
  delete?: string[] | AttributesList;
}

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
 * project's `lib` target; the code itself is what callers read.
 */
function ldapError(context: string, error: unknown): Error {
  const wrapped = new Error(`${context}: ${String(error)}`);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'number') (wrapped as { code?: number }).code = code;
  return wrapped;
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
  const wrapped = ldapError('LDAP add error', error);
  if ((wrapped as { code?: number }).code !== 68) return wrapped;
  const conflict = new ConflictError(`Entry ${dn} already exists`);
  (conflict as { code?: number }).code = 68;
  return conflict;
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

  constructor(server: DM) {
    this.parent = server;
    this.logger = server.logger;
    this.config = server.config;

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
      throw new Error('LDAP DN is not defined');
    }
    if (!server.config.ldap_pwd) {
      throw new Error('LDAP password is not defined');
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
      const client = await this.createConnection();
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

  /*
    LDAP search
   */
  /**
   * The directory as the server itself, with no request behind it.
   *
   * Every authorization plugin skips its check when a call carries no
   * request, so an unbound call is a bypass — a deliberate one where the
   * work belongs to nobody in particular: a startup task, a cron job, a
   * uniqueness check, a referential-integrity check. Those must see the
   * whole directory to be correct: a caller who cannot *read* `uid=jdoe`
   * must still not be handed it as a free identifier, and a reference to an
   * organization they cannot read is still a valid reference.
   *
   * The methods are the same objects as this instance's own — writes
   * included, since a scheduled task writes: the examples above are reads
   * because that is where the ambiguity lives, not because a write cannot
   * belong to nobody. What this adds is a name: `ldap.system.search(…)` says
   * the omission was meant, where `ldap.search(…)` says nothing and looks
   * exactly like the mistake it takes one review to miss. A plugin serving a
   * request should reach for {@link forRequest} instead.
   */
  get system(): this {
    return this;
  }

  /**
   * Bind every directory operation to one request, so the authorization
   * hooks always see it. See {@link RequestBoundLdap}.
   */
  forRequest(req: Request): RequestBoundLdap {
    return {
      search: (options, base) => this.search(options, base ?? this.base, req),
      add: (dn, entry) => this.add(dn, entry, req),
      modify: (dn, changes) => this.modify(dn, changes, req),
      rename: (dn, newRdn) => this.rename(dn, newRdn, req),
      delete: dn => this.delete(dn, req),
    };
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
        ? pooled.client.searchPaginated(base, opts)
        : pooled.client.search(base, opts);
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
    dn = this.setDn(dn);
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

    // Convert to Attribute objects
    const attributes: Attribute[] = [];
    for (const [key, value] of Object.entries(sanitizedEntry)) {
      const values = Array.isArray(value) ? value : [value];
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
      void launchHooks(
        this.parent.hooks.ldapadddone,
        [dn, entry],
        changeContext(req)
      );
      return true;
    } catch (error) {
      throw ldapAddError(dn, error);
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /*
    LDAP modify
   */
  async modify(
    dn: string,
    changes: ModifyRequest,
    req?: Request
  ): Promise<boolean> {
    dn = this.setDn(dn);
    const ldapChanges: Change[] = [];
    const op: number = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.parent.hooks.ldapmodifyrequest,
      [dn, changes, op, req]
    );
    if (changes.add) {
      for (const [key, value] of Object.entries(changes.add)) {
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
    if (ldapChanges.length !== 0) {
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
        await pooled.client.modify(dn, ldapChanges);
        // Invalidate cache for this DN
        this.invalidateCache(dn);
        void launchHooks(
          this.parent.hooks.ldapmodifydone,
          [dn, changes, op],
          changeContext(req)
        );
        return true;
      } catch (error) {
        this.logger.warn(
          `Changes that failed: ${dn}, ${JSON.stringify(ldapChanges)}`
        );
        throw ldapError(`LDAP modify error`, error);
      } finally {
        this.releaseConnection(pooled);
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
      void launchHooks(
        this.parent.hooks.ldapmodifydone,
        [dn, {}, op],
        changeContext(req)
      );
      return false;
    }
  }

  async rename(dn: string, newRdn: string, req?: Request): Promise<boolean> {
    dn = this.setDn(dn);
    newRdn = this.setDn(newRdn);
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
      await pooled.client.modifyDN(dn, newRdn);
      // Invalidate both ends. A base-scope read of the old DN would
      // otherwise keep answering the entry that is no longer there, and a
      // read cached under the new DN — of whatever used to carry it — would
      // hide the entry that just took its place. `invalidateCache` drops the
      // subtree too: renaming a container moves every DN under it.
      this.invalidateCache(dn);
      this.invalidateCache(newRdn);
      void launchHooks(
        this.parent.hooks.ldaprenamedone,
        [dn, newRdn],
        changeContext(req)
      );
      return true;
    } catch (error) {
      throw ldapError(`LDAP rename error`, error);
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /**
   * Move an entry to a new location (different parent)
   * Uses LDAP modifyDN with full DN to change both RDN and parent
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
      await pooled.client.modifyDN(dn, newDn);
      // Invalidate both ends — see rename() above for why both matter.
      this.invalidateCache(dn);
      this.invalidateCache(newDn);
      // A move is a modifyDN, so it is a rename: the plugins that watch a
      // rename watch a move, and the two caches that outlive the search cache
      // (the authz group cache, the identity → DN resolution cache) are
      // dropped by the same hook. `ldaprenamerequest` is deliberately not
      // launched: it is an authorization hook, and this write has already
      // been judged by the `ldap*request` hook of whatever drove it —
      // re-running it here would judge the same write twice.
      void launchHooks(
        this.parent.hooks.ldaprenamedone,
        [dn, newDn],
        changeContext(req)
      );
      this.logger.debug(`LDAP move: ${dn} -> ${newDn}`);
      return true;
    } catch (error) {
      throw ldapError(`LDAP move error`, error);
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /*
    LDAP delete
   */
  async delete(dn: string | string[], req?: Request): Promise<boolean> {
    if (Array.isArray(dn)) {
      dn = dn.map(d => this.setDn(d));
    } else {
      dn = this.setDn(dn);
    }
    if (!Array.isArray(dn)) dn = [dn];
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
          await pooled.client.del(entry);
          // Invalidate cache for this DN
          this.invalidateCache(entry);
        } catch (error) {
          throw ldapError(`LDAP delete error`, error);
        }
        void launchHooks(
          this.parent.hooks.ldapdeletedone,
          entry,
          changeContext(req)
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

  opNumber(): number {
    return this.parent.operationSequence++;
  }
}

export default ldapActions;
