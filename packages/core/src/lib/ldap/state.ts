/**
 * The LDAP connection state the façade sets up once: the pool, the search
 * cache, the concurrency limit and the default base.
 */
import type { ClientOptions } from 'ldapts';
import pLimit from 'p-limit';

import type { DM } from '../../bin/index.js';
import { outsideRequest } from '../requestContext.js';

import type { LdapHost } from './operations.js';
import LdapPool from './pool.js';
import SearchCache from './searchCache.js';

export const SYSTEM_OPERATIONS = new Set<string | symbol>([
  'search',
  'add',
  'modify',
  'rename',
  'move',
  'delete',
]);

export interface LdapState {
  pool: LdapPool;
  cache: SearchCache;
  queryLimit: ReturnType<typeof pLimit>;
  base: string;
}

/**
 * @param server the server whose configuration names the directory
 * @param knowAttributeNames receives the attribute names the options give
 * @returns the connection state
 */
export function createLdapState(
  server: DM,
  knowAttributeNames: (names: Iterable<string>) => void
): LdapState {
  // The attribute names the options give: the plugins compare with these
  for (const [key, value] of Object.entries(server.config))
    if (/_attributes?$/.test(key))
      knowAttributeNames(
        [value].flat().filter((v): v is string => typeof v === 'string')
      );

  // Initialize global LDAP query concurrency limiter
  const concurrency = server.config.ldap_concurrency || 10;
  const queryLimit = pLimit(concurrency);
  server.logger.info(
    `Global LDAP query concurrency limit set to ${concurrency}`
  );

  // Initialize the search cache
  const cacheMax: number =
    typeof server.config.ldap_cache_max === 'string'
      ? parseInt(server.config.ldap_cache_max, 10) || 1000
      : (server.config.ldap_cache_max ?? 1000);
  // `--ldap-cache-ttl` defaults to 0, and 0 means "do not cache": anything
  // writing the directory without going through this process — LSC,
  // ldapmodify, a second replica — leaves this one answering the entry it
  // read before for the whole TTL, and no write path here can know. A
  // deployment that wants the cache turns it on deliberately.
  const ttlSetting = server.config.ldap_cache_ttl;
  const cacheTtlSeconds =
    typeof ttlSetting === 'string'
      ? parseInt(ttlSetting, 10) || 0
      : (ttlSetting ?? 0);
  const cacheTtl = Math.max(cacheTtlSeconds, 0) * 1000; // seconds to ms
  const cache = new SearchCache({
    max: cacheMax,
    ttl: cacheTtl,
    logger: server.logger,
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
  const base = server.config.ldap_base;
  const ldapUrls = server.config.ldap_url;
  const options: ClientOptions = {
    url: ldapUrls[0],
    timeout: 0,
    connectTimeout: 0,
    strictDN: false,
  };
  if (ldapUrls[0].startsWith('ldaps://')) {
    options.tlsOptions = {
      minVersion: 'TLSv1.2',
    };
  }
  const pool = new LdapPool({
    urls: ldapUrls,
    dn: server.config.ldap_dn,
    pwd: server.config.ldap_pwd,
    options,
    poolSize: server.config.ldap_pool_size || 5,
    connectionTtl: (server.config.ldap_connection_ttl || 60) * 1000,
    logger: server.logger,
  });
  return { pool, cache, queryLimit, base };
}

export async function ping(host: LdapHost, timeoutMs: number): Promise<void> {
  await host.pool.ping(timeoutMs);
}

export async function close(host: LdapHost): Promise<void> {
  await host.pool.close();
}

export function poolStats(host: LdapHost): {
  busy: number;
  idle: number;
  waiting: number;
  opening: number;
  max: number;
} {
  return host.pool.stats();
}

export function invalidateCache(host: LdapHost, dn: string): void {
  host.cache.invalidate(dn);
}

export function systemView<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (object, prop): unknown => {
      const value: unknown = Reflect.get(object, prop, object);
      if (typeof value !== 'function' || !SYSTEM_OPERATIONS.has(prop))
        return value;
      return (...args: unknown[]): unknown =>
        outsideRequest(() =>
          (value as (...a: unknown[]) => unknown).apply(object, args)
        );
    },
  });
}
