/**
 * The directory connections this server keeps: failover between the URLs,
 * a bounded pool with a TTL, and the readiness probe on a connection of its
 * own.
 */
import { Client } from 'ldapts';
import type { ClientOptions } from 'ldapts';

import { outsideAnyRequest } from '../requestContext';
import { ldapPoolWait, secondsSince, timedLdap } from '../metrics';

export interface PoolLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PooledConnection {
  client: Client;
  createdAt: number;
  inUse: boolean;
}

/**
 * What a queued request is told when the pool changes: a connection handed
 * over, a place freed with none to give (it takes the place again), or why
 * it gets none.
 */
type WaiterOutcome =
  | { connection: PooledConnection }
  | { retry: true }
  | { error: Error };

/** Opens a client; binding is the pool's, so a fake can stand in. */
export type ClientFactory = (
  options: ClientOptions
) => Client | Promise<Client>;

export interface LdapPoolOptions {
  /** The URLs to try. */
  urls: string[];
  dn: string;
  pwd: string;
  /** Options shared by every URL; the pool sets `url` and `tlsOptions`. */
  options: ClientOptions;
  poolSize: number;
  connectionTtl: number;
  logger: PoolLogger;
  clientFactory?: ClientFactory;
}

export default class LdapPool {
  private readonly urls: string[];
  private readonly dn: string;
  private readonly pwd: string;
  private readonly options: ClientOptions;
  private readonly poolSize: number;
  private readonly connectionTtl: number;
  private readonly logger: PoolLogger;
  private readonly clientFactory: ClientFactory;

  private connectionPool: PooledConnection[] = [];
  private availableConnections: PooledConnection[] = [];
  private waitingResolvers: Array<(outcome: WaiterOutcome) => void> = [];
  /** Connections being opened, not yet in `connectionPool` */
  private opening = 0;
  private isCleaningUp = false;
  private currentUrlIndex = 0;
  /** Set by `close`: no connection is handed out any more */
  private closed = false;

  constructor(options: LdapPoolOptions) {
    this.urls = options.urls;
    this.dn = options.dn;
    this.pwd = options.pwd;
    this.options = options.options;
    this.poolSize = options.poolSize;
    this.connectionTtl = options.connectionTtl;
    this.logger = options.logger;
    this.clientFactory =
      options.clientFactory ?? ((opts): Client => new Client(opts));
    this.logger.info(
      `LDAP connection pool initialized: size=${this.poolSize}, ttl=${this.connectionTtl / 1000}s`
    );
    this.logger.info(
      `LDAP failover configured with ${this.urls.length} URL(s): ${this.urls.join(', ')}`
    );
  }

  /**
   * Create a new LDAP connection with failover support
   */
  private async createConnection(): Promise<Client> {
    const errors: Error[] = [];
    const urls = this.urls;

    for (let i = 0; i < urls.length; i++) {
      const urlIndex = (this.currentUrlIndex + i) % urls.length;
      const url = urls[urlIndex];

      try {
        this.logger.debug(`Attempting connection to ${url}`);
        const options: ClientOptions = {
          ...this.options,
          url,
          tlsOptions: url.startsWith('ldaps://')
            ? { minVersion: 'TLSv1.2' }
            : undefined,
        };

        const client: Client = await this.clientFactory(options);
        await timedLdap('bind', () => client.bind(this.dn, this.pwd));

        if (urlIndex !== this.currentUrlIndex) {
          this.logger.info(
            `LDAP failover: switched from ${urls[this.currentUrlIndex]} to ${url}`
          );
          this.currentUrlIndex = urlIndex;
        }

        return client;
      } catch (error) {
        this.logger.warn(`Failed to connect to ${url}: ${String(error)}`);
        errors.push(error as Error);
      }
    }

    this.logger.error(`LDAP connection failed for all ${urls.length} URL(s)`);
    throw new Error(
      `LDAP connection failed for all URLs: ${errors.map(e => e.message).join(', ')}`
    );
  }

  /**
   * Clean up expired connections from the pool
   * Uses a flag to prevent concurrent cleanup operations
   */
  private cleanupExpiredConnections(): void {
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
   * Ask the directory for its root DSE on a connection of its own, bound
   * as the server and closed after: the readiness probe. Neither the pool
   * nor the search cache nor the hooks answer for a directory that does
   * not, and a directory that stops answering holds nothing of the pool.
   * The URLs are tried as `createConnection` tries them.
   *
   * @param timeoutMs how long the connection, the bind and the search may
   *   each take; the client closes the socket when it passes
   * @throws when no URL answers in time
   */
  async ping(timeoutMs: number): Promise<void> {
    if (this.closed) throw new Error('LDAP connections closed');
    const errors: string[] = [];
    const urls = this.urls;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[(this.currentUrlIndex + i) % urls.length];
      const options: ClientOptions = {
        ...this.options,
        url,
        timeout: timeoutMs,
        connectTimeout: timeoutMs,
        tlsOptions: url.startsWith('ldaps://')
          ? { minVersion: 'TLSv1.2' }
          : undefined,
      };
      let client: Client | undefined;
      try {
        client = await this.clientFactory(options);
        await client.bind(this.dn, this.pwd);
        await client.search('', { scope: 'base', attributes: ['1.1'] });
        return;
      } catch (error) {
        errors.push(`${url}: ${String(error)}`);
      } finally {
        await client?.unbind().catch(() => undefined);
      }
    }
    throw new Error(`No directory answered: ${errors.join(', ')}`);
  }

  /**
   * Close every pooled connection, the ones in use included: an operation
   * still running on one is rejected by the client, and a waiter is refused
   * rather than kept.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.refuseWaiters(new Error('LDAP connections closed'));
    const pooled = this.connectionPool.splice(0);
    this.availableConnections.length = 0;
    await Promise.allSettled(pooled.map(conn => conn.client.unbind()));
  }

  /**
   * Acquire a connection from the pool or create a new one
   * Optimized for O(1) lookup using separate available connections queue
   */
  async acquire(): Promise<PooledConnection> {
    const started = process.hrtime.bigint();
    try {
      return await this.takeConnection();
    } finally {
      ldapPoolWait.observe(secondsSince(started));
    }
  }

  /**
   * Run `operation` on a pooled connection, released whatever becomes of it.
   */
  async withConnection<T>(
    operation: (client: Client) => Promise<T>
  ): Promise<T> {
    const pooled = await this.acquire();
    try {
      return await operation(pooled.client);
    } finally {
      this.release(pooled);
    }
  }

  /** The pool as it is, for the metrics */
  stats(): {
    busy: number;
    idle: number;
    waiting: number;
    opening: number;
    max: number;
  } {
    return {
      busy: this.connectionPool.length - this.availableConnections.length,
      idle: this.availableConnections.length,
      waiting: this.waitingResolvers.length,
      opening: this.opening,
      max: this.poolSize,
    };
  }

  private async takeConnection(): Promise<PooledConnection> {
    if (this.closed) throw new Error('LDAP connections closed');
    // Clean up expired connections
    this.cleanupExpiredConnections();

    // O(1) - Try to pop from available connections queue
    if (this.availableConnections.length > 0) {
      const conn = this.availableConnections.pop()!;
      conn.inUse = true;
      this.logger.debug('Reusing pooled LDAP connection');
      return conn;
    }

    // The place is taken before the first `await`: on an empty pool, a
    // burst of acquires all reach this check before any of them returns.
    if (this.connectionPool.length + this.opening < this.poolSize) {
      this.opening++;
      try {
        // Outside the request it is opened for: the connection outlives it
        const client = await outsideAnyRequest(() => this.createConnection());
        if (this.closed) {
          await client.unbind().catch(() => undefined);
          throw new Error('LDAP connections closed');
        }
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
      } catch (error) {
        // The place the open took is free again, but no release will hand it
        // over: the waiters get the error instead of the timeout
        this.refuseWaiters(
          error instanceof Error ? error : new Error(String(error))
        );
        throw error;
      } finally {
        this.opening--;
      }
    }

    // Pool is full, wait for an available connection using Promise with timeout
    this.logger.debug(
      'LDAP connection pool full, waiting for available connection'
    );
    return new Promise<PooledConnection>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        const idx = this.waitingResolvers.indexOf(settle);
        if (idx !== -1) this.waitingResolvers.splice(idx, 1);
        reject(new Error('LDAP connection pool timeout after 30s'));
      }, 30000);

      const settle = (outcome: WaiterOutcome): void => {
        globalThis.clearTimeout(timeoutId);
        if ('error' in outcome) reject(outcome.error);
        else if ('retry' in outcome) resolve(this.takeConnection());
        else resolve(outcome.connection);
      };
      this.waitingResolvers.push(settle);
    });
  }

  /** Refuse every queued request with `error` */
  private refuseWaiters(error: Error): void {
    for (const waiter of this.waitingResolvers.splice(0)) waiter({ error });
  }

  /** Let one queued request take a place that freed with no connection */
  private wakeWaiter(): void {
    this.waitingResolvers.shift()?.({ retry: true });
  }

  /**
   * Release a connection back to the pool
   * If there are waiting requests, hand off the connection directly
   */
  release(pooled: PooledConnection): void {
    // A connection being opened when `close` ran, or returned by an
    // operation still running after it, has no pool to go back to
    if (this.closed) {
      void pooled.client.unbind().catch(() => undefined);
      return;
    }

    if (Date.now() - pooled.createdAt > this.connectionTtl) {
      const idx = this.connectionPool.indexOf(pooled);
      if (idx !== -1) this.connectionPool.splice(idx, 1);
      void pooled.client.unbind().catch(() => {});
      this.logger.debug('Released expired LDAP connection (discarded)');
      this.wakeWaiter();
      return;
    }

    // If there are waiting requests, give them the connection directly (O(1))
    if (this.waitingResolvers.length > 0) {
      const waiter = this.waitingResolvers.shift()!;
      // Connection stays in use, just transfer ownership
      this.logger.debug('Released LDAP connection to waiting request');
      waiter({ connection: pooled });
      return;
    }

    pooled.inUse = false;
    this.availableConnections.push(pooled);
    this.logger.debug('Released LDAP connection back to pool');
  }
}
