/**
 * LDAP low-level library: the façade the plugins use.
 *
 * The operation pipeline lives in `lib/ldap/operations.ts` and
 * `lib/ldap/read.ts`; this class holds the server state they share and
 * forwards the public API.
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Request } from 'express';
import type { SearchOptions, SearchResult } from 'ldapts';
import type winston from 'winston';
import pLimit from 'p-limit';

import type { Config } from '../config/args';
import type { DM } from '../bin';
import type { Hooks } from '../hooks';

import LdapPool from './ldap/pool';
import SearchCache from './ldap/searchCache';
import DirectorySchema from './ldap/schema';
import CallerView from './ldap/callerView';
import { createLdapState } from './ldap/state';
import { BadRequestError } from './errors';
import type { SchemaIndex } from './ldapSchema';
import type { ChangeContext } from './changeContext';
import {
  add as addOperation,
  modify as modifyOperation,
  move as moveOperation,
  opNumber as operationNumber,
  remove as removeOperation,
  rename as renameOperation,
  type LdapHost,
} from './ldap/operations';
import {
  close as closeOperation,
  invalidateCache as invalidateCacheOperation,
  ping as pingOperation,
  poolStats as poolStatsOperation,
  systemView,
} from './ldap/state';
import {
  authorize as authorizeOperation,
  search as searchOperation,
} from './ldap/read';
import type { AuthorizedHook } from './ldap/read';

// Typescript interface

// Entry
export type AttributeValue = Buffer | Buffer[] | string[] | string;
export type AttributesList = Record<string, AttributeValue>;
export type LdapList = Record<string, AttributesList>;

export type { SearchOptions, SearchResult };

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

class ldapActions {
  config: Config;
  base: string;
  parent: DM;
  logger: winston.Logger;
  private cache: SearchCache;
  public queryLimit: ReturnType<typeof pLimit>;
  private pool: LdapPool;
  private schema: DirectorySchema;
  private caller: CallerView;

  constructor(server: DM) {
    this.parent = server;
    this.logger = server.logger;
    this.config = server.config;
    this.schema = new DirectorySchema({
      logger: this.logger,
      search: (options, base): ReturnType<ldapActions['search']> =>
        this.system.search(options, base),
      autoRepair: (): boolean => this.config.ldap_flat_auto_repair !== false,
      schemaCacheTtl: (): number =>
        (this.config.ldap_raw_schema_cache_ttl ?? 3600) * 1000,
    });
    this.caller = new CallerView({
      search: (options, base, req): ReturnType<ldapActions['search']> =>
        this.search(options, base, req),
      hasFilter: (): boolean => this.parent.hookBus.has('ldapsearchfilter'),
      filter: async (chunk, req, opts): Promise<SearchResult> => {
        const [filtered] = await this.parent.hookBus.chain('ldapsearchfilter', [
          chunk,
          req,
          opts,
        ]);
        return filtered ?? chunk;
      },
    });
    const state = createLdapState(server, names =>
      this.knowAttributeNames(names)
    );
    this.pool = state.pool;
    this.cache = state.cache;
    this.queryLimit = state.queryLimit;
    this.base = state.base;
  }

  private get host(): LdapHost {
    return {
      parent: this.parent,
      config: this.config,
      base: this.base,
      logger: this.logger,
      pool: this.pool,
      cache: this.cache,
      schema: this.schema,
      caller: this.caller,
    };
  }

  /** See {@link LdapPool.ping}. */
  /** See {@link LdapPool.ping}. */
  async ping(timeoutMs: number): Promise<void> {
    await pingOperation(this.host, timeoutMs);
  }

  /** See {@link LdapPool.close}. */
  async close(): Promise<void> {
    await closeOperation(this.host);
  }

  /** The pool as it is, for the metrics */
  poolStats(): {
    busy: number;
    idle: number;
    waiting: number;
    opening: number;
    max: number;
  } {
    return poolStatsOperation(this.host);
  }

  /** Drop every cached read of `dn`, and of everything below it. */
  invalidateCache(dn: string): void {
    invalidateCacheOperation(this.host, dn);
  }
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
    this.systemView ??= systemView(this);
    return this.systemView;
  }

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
  /** See {@link CallerView.readableBy}. */
  async readableBy(dn: string, req?: Request): Promise<boolean> {
    return this.caller.readableBy(dn, req);
  }
  /** See {@link DirectorySchema.declareObjectClasses}. */
  declareObjectClasses(
    base: string,
    classes: string[] | string,
    includeBase = false
  ): void {
    this.schema.declareObjectClasses(base, classes, includeBase);
  }

  /** See {@link DirectorySchema.subschemaDn}. */
  async subschemaDn(): Promise<string> {
    return this.schema.subschemaDn();
  }

  /** See {@link DirectorySchema.schemaIndex}. */
  async schemaIndex(): Promise<SchemaIndex> {
    return this.schema.schemaIndex();
  }

  /** See {@link DirectorySchema.knowAttributeNames}. */
  knowAttributeNames(names: Iterable<string>): void {
    this.schema.knowAttributeNames(names);
  }

  /** See {@link DirectorySchema.canonicalAttributes}. */
  async canonicalAttributes(entry: AttributesList | undefined): Promise<void> {
    await this.schema.canonicalAttributes(entry);
  }

  /** See {@link DirectorySchema.canonicalChanges}. */
  async canonicalChanges(changes: ModifyRequest | undefined): Promise<void> {
    await this.schema.canonicalChanges(changes);
  }

  async search(
    options: SearchOptions,
    base: string = this.base,
    req?: Request
  ): Promise<SearchResult | AsyncGenerator<SearchResult>> {
    return searchOperation(this.host, options, base, req);
  }

  async add(
    dn: string,
    entry: AttributesList,
    req?: Request
  ): Promise<boolean> {
    return addOperation(this.host, dn, entry, req);
  }

  async modify(
    dn: string,
    changes: ModifyRequest,
    req?: Request,
    options: ModifyOptions = {}
  ): Promise<boolean> {
    return modifyOperation(this.host, dn, changes, req, options);
  }

  async rename(dn: string, newRdn: string, req?: Request): Promise<boolean> {
    return renameOperation(this.host, dn, newRdn, req);
  }

  /**
   * Move an entry to a new location: a move is the server's, made for a write
   * already judged, and a route moving for its caller uses {@link rename}.
   */
  async move(dn: string, newDn: string, req?: Request): Promise<boolean> {
    return moveOperation(this.host, dn, newDn, req);
  }

  async delete(
    dn: string | string[],
    req?: Request,
    options: Pick<ModifyOptions, 'context'> = {}
  ): Promise<boolean> {
    return removeOperation(this.host, dn, req, options);
  }

  /**
   * Have the authorization plugins judge an operation, without making it.
   *
   * A route that looks in the directory before it writes answers what it
   * found, as the server, to whoever asked. Judged first, they get the 403
   * the write itself would get, whether the entry is there or not.
   *
   * Only the hooks of the plugins with the `authz` role run, and what they
   * return is dropped: the operation, when it is made, runs every hook
   * again.
   *
   * @param hook the request hook the operation launches
   * @param args what the operation hands that hook
   * @throws the refusal of the first authorization plugin refusing
   */
  async authorize<H extends AuthorizedHook>(
    hook: H,
    args: Parameters<NonNullable<Hooks[H]>>[0]
  ): Promise<void> {
    return authorizeOperation(this.host, hook, args);
  }

  opNumber(): number {
    return operationNumber(this.host);
  }
}

export default ldapActions;
