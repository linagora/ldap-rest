/**
 * LDAP low-level library
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Request } from 'express';
import { Client, Attribute, Change } from 'ldapts';
import type { ClientOptions, SearchResult, SearchOptions } from 'ldapts';
import type winston from 'winston';
import { LRUCache } from 'lru-cache';

import { type Config } from '../config/args';
import { type DM } from '../bin';

import { launchHooks, launchHooksChained } from './utils';

// Typescript interface

// Entry
export type AttributeValue = Buffer | Buffer[] | string[] | string;
export type AttributesList = Record<string, AttributeValue>;
export type LdapList = Record<string, AttributesList>;

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

  constructor(server: DM) {
    this.parent = server;
    this.logger = server.logger;
    this.config = server.config;

    // Initialize LRU cache for search results
    const cacheMax = this.config.ldap_cache_max || 1000;
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
    if (!server.config.ldap_url) {
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
    this.options = {
      url: server.config.ldap_url,
      timeout: 0,
      connectTimeout: 0,
      strictDN: false,
    };
    if (server.config.ldap_url.startsWith('ldaps://')) {
      this.options.tlsOptions = {
        minVersion: 'TLSv1.2',
      };
    }
    this.dn = server.config.ldap_dn;
    this.pwd = server.config.ldap_pwd;
  }

  /* Connect to LDAP server

   Here we choose to have no persistent LDAP connection
   This is safer because a persistent connection must
   be monitored and reconnected if needed
   and such admin tool won't push a lot of requests
   */
  async connect(): Promise<Client> {
    const client: Client = new Client(this.options);
    try {
      await client.bind(this.dn, this.pwd);
    } catch (error) {
      this.logger.error('LDAP bind error:', error);
      throw new Error('LDAP bind error');
    }
    if (!client) throw new Error('LDAP connection error');
    return client;
  }

  /**
   * Generate cache key for LDAP search
   */
  private getCacheKey(base: string, opts: SearchOptions): string {
    // Create a deterministic cache key from base DN and search options
    // Sort attributes to ensure consistent key generation
    const sortedAttrs = opts.attributes
      ? [...opts.attributes].sort().join(',')
      : '*';
    return `${base}:${opts.scope || 'sub'}:${opts.filter || '(objectClass=*)'}:${sortedAttrs}`;
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
    const client = await this.connect();
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

    let res = opts.paged
      ? client.searchPaginated(base, opts)
      : client.search(base, opts);
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

    return res;
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
    const client = await this.connect();
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

    try {
      await client.add(dn, attributes);
      void client.unbind();
      // Invalidate cache for this DN
      this.invalidateCache(dn);
      void launchHooks(this.parent.hooks.ldapadddone, [dn, entry]);
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP add error: ${error}`);
    }
  }

  /*
    LDAP modify
   */
  async modify(dn: string, changes: ModifyRequest): Promise<boolean> {
    dn = this.setDn(dn);
    const ldapChanges: Change[] = [];
    const op: number = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.parent.hooks.ldapmodifyrequest,
      [dn, changes, op]
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
      const client = await this.connect();
      try {
        await client.modify(dn, ldapChanges);
        void client.unbind();
        // Invalidate cache for this DN
        this.invalidateCache(dn);
        void launchHooks(this.parent.hooks.ldapmodifydone, [dn, changes, op]);
        return true;
      } catch (error) {
        this.logger.warn(
          `Changes that failed: ${dn}, ${JSON.stringify(ldapChanges)}`
        );
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`LDAP modify error: ${error}`);
      }
    } else {
      this.logger.error('No changes to apply');
      void launchHooks(this.parent.hooks.ldapmodifydone, [dn, {}, op]);
      return false;
    }
  }

  async rename(dn: string, newRdn: string): Promise<boolean> {
    dn = this.setDn(dn);
    newRdn = this.setDn(newRdn);
    [dn, newRdn] = await launchHooksChained(
      this.parent.hooks.ldaprenamerequest,
      [dn, newRdn]
    );
    const client = await this.connect();
    try {
      await client.modifyDN(dn, newRdn);
      void client.unbind();
      void launchHooks(this.parent.hooks.ldaprenamedone, [dn, newRdn]);
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP rename error: ${error}`);
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
    const client = await this.connect();
    try {
      await client.modifyDN(dn, newDn);
      void client.unbind();
      this.logger.debug(`LDAP move: ${dn} -> ${newDn}`);
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP move error: ${error}`);
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
    const client = await this.connect();
    for (const entry of dn) {
      try {
        await client.del(entry);
        void client.unbind();
        // Invalidate cache for this DN
        this.invalidateCache(entry);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`LDAP delete error: ${error}`);
      }
      void launchHooks(this.parent.hooks.ldapdeletedone, entry);
    }
    return true;
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
