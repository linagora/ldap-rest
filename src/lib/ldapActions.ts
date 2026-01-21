/**
 * LDAP low-level library
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Request } from 'express';
import { Client, Attribute, Change } from 'ldapts';
import type { ClientOptions, SearchResult, SearchOptions } from 'ldapts';
import type winston from 'winston';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';

import { type Config } from '../config/args';
import { type DM } from '../bin';

import { launchHooks, launchHooksChained } from './utils';

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

// modify
export interface ModifyRequest {
  add?: AttributesList;
  replace?: AttributesList;
  delete?: string[] | AttributesList;
}

// Code

class ldapActions {
  config: Config;
  options: ClientOptions;
  dn: string;
  pwd: string;
  base: string;
  parent: DM;
  logger: winston.Logger;
  private searchCache: LRUCache<string, SearchResult>;
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
    const cacheTtl = (this.config.ldap_cache_ttl || 300) * 1000; // Convert seconds to ms
    this.searchCache = new LRUCache<string, SearchResult>({
      max: cacheMax,
      ttl: cacheTtl,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });
    this.logger.info(
      `LDAP search cache initialized: max=${cacheMax}, ttl=${cacheTtl / 1000}s`
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
    if (!server.config.ldap_base) {
      this.base = server.config.ldap_dn.split(',', 2)[1];
      this.logger.warn(`LDAP base is not defined, using "${this.base}"`);
    } else {
      this.base = server.config.ldap_base;
    }
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
      const timeoutId = setTimeout(() => {
        const idx = this.waitingResolvers.indexOf(resolveWrapper);
        if (idx !== -1) this.waitingResolvers.splice(idx, 1);
        reject(new Error('LDAP connection pool timeout after 30s'));
      }, 30000);

      const resolveWrapper = (conn: PooledConnection): void => {
        clearTimeout(timeoutId);
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
   */
  private getCacheKey(base: string, opts: SearchOptions): string {
    // Create a deterministic cache key from base DN and search options
    const sortedAttrs = this.getAttributeSignature(opts.attributes);
    const filterStr =
      typeof opts.filter === 'string'
        ? opts.filter
        : opts.filter
          ? opts.filter.toString()
          : '(objectClass=*)';
    return `${base}:${opts.scope || 'sub'}:${filterStr}:${sortedAttrs}`;
  }

  /**
   * Invalidate cache entries for a specific DN
   * Called after modifications to ensure cache consistency
   */
  invalidateCache(dn: string): void {
    // Remove all cache entries that match this DN
    for (const key of this.searchCache.keys()) {
      if (key.startsWith(dn)) {
        this.searchCache.delete(key);
      }
    }
  }

  /*
    LDAP search
   */
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

    // Check cache for non-paginated, base-scope searches only
    // These are the most common for attribute lookups
    if (!opts.paged && opts.scope === 'base') {
      const cacheKey = this.getCacheKey(base, opts);
      const cached = this.searchCache.get(cacheKey);
      if (cached) {
        this.logger.debug(`LDAP search cache hit: ${cacheKey}`);
        return cached;
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

      // Cache non-paginated, base-scope search results
      if (!opts.paged && opts.scope === 'base' && res instanceof Promise) {
        const result = await res;
        const cacheKey = this.getCacheKey(base, opts);
        this.searchCache.set(cacheKey, result);
        this.logger.debug(`LDAP search cached: ${cacheKey}`);
        return result;
      }

      // For paginated searches, return a wrapped generator that releases connection when done
      if (opts.paged) {
        return this.wrapPaginatedSearch(
          res as AsyncGenerator<SearchResult>,
          pooled
        );
      }

      return res;
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
      await pooled.client.add(dn, attributes);
      // Invalidate cache for this DN
      this.invalidateCache(dn);
      void launchHooks(this.parent.hooks.ldapadddone, [dn, entry]).catch(
        err => {
          this.logger.error(`Hook ldapadddone failed: ${String(err)}`);
        }
      );
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP add error: ${error}`);
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
        await pooled.client.modify(dn, ldapChanges);
        // Invalidate cache for this DN
        this.invalidateCache(dn);
        void launchHooks(this.parent.hooks.ldapmodifydone, [
          dn,
          changes,
          op,
        ]).catch(err => {
          this.logger.error(`Hook ldapmodifydone failed: ${String(err)}`);
        });
        return true;
      } catch (error) {
        this.logger.warn(
          `Changes that failed: ${dn}, ${JSON.stringify(ldapChanges)}`
        );
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`LDAP modify error: ${error}`);
      } finally {
        this.releaseConnection(pooled);
      }
    } else {
      this.logger.error('No changes to apply');
      void launchHooks(this.parent.hooks.ldapmodifydone, [dn, {}, op]).catch(
        err => {
          this.logger.error(`Hook ldapmodifydone failed: ${String(err)}`);
        }
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
      await pooled.client.modifyDN(dn, newRdn);
      void launchHooks(this.parent.hooks.ldaprenamedone, [dn, newRdn]).catch(
        err => {
          this.logger.error(`Hook ldaprenamedone failed: ${String(err)}`);
        }
      );
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP rename error: ${error}`);
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
   */
  async move(dn: string, newDn: string): Promise<boolean> {
    dn = this.setDn(dn);
    newDn = this.setDn(newDn);
    const pooled = await this.acquireConnection();
    try {
      await pooled.client.modifyDN(dn, newDn);
      this.logger.debug(`LDAP move: ${dn} -> ${newDn}`);
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP move error: ${error}`);
    } finally {
      this.releaseConnection(pooled);
    }
  }

  /*
    LDAP delete
   */
  async delete(dn: string | string[]): Promise<boolean> {
    if (Array.isArray(dn)) {
      dn = dn.map(d => this.setDn(d));
    } else {
      dn = this.setDn(dn);
    }
    if (!Array.isArray(dn)) dn = [dn];
    dn = (await launchHooksChained(
      this.parent?.hooks.ldapdeleterequest,
      dn
    )) as string | string[];

    const pooled = await this.acquireConnection();
    try {
      for (const entry of dn) {
        try {
          await pooled.client.del(entry);
          // Invalidate cache for this DN
          this.invalidateCache(entry);
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          throw new Error(`LDAP delete error: ${error}`);
        }
        void launchHooks(this.parent.hooks.ldapdeletedone, entry).catch(err => {
          this.logger.error(`Hook ldapdeletedone failed: ${String(err)}`);
        });
      }
      return true;
    } finally {
      this.releaseConnection(pooled);
    }
  }

  private setDn(dn: string): string {
    if (!/=/.test(dn)) {
      dn = `${this.config.ldap_user_main_attribute as string}=${dn},${this.base}`;
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
