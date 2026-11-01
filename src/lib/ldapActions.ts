/**
 * LDAP low-level library
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Request } from 'express';
import { Attribute, Change, Control } from 'ldapts';
import type { ClientOptions, SearchResult, SearchOptions } from 'ldapts';
import type winston from 'winston';
import pLimit from 'p-limit';

import { type Config } from '../config/args';
import { type DM } from '../bin';
import type { Hooks } from '../hooks';

import { escapeDnValue, getParentDn, hookOwner, rdnTypes } from './utils';
import { changeContext, type ChangeContext } from './changeContext';
import HookBus from './hookBus';
import { outsideOperation, runOperation } from './operation';
import { currentRequest, outsideRequest } from './requestContext';
import {
  ldapOperationDuration,
  ldapResult,
  ldapSearchCache,
  secondsSince,
  timedLdap,
} from './metrics';
import LdapPool from './ldap/pool';
import SearchCache, { digestKey, membersNamed } from './ldap/searchCache';
import DirectorySchema from './ldap/schema';
import CallerView from './ldap/callerView';
import { BadRequestError, ConflictError, NotFoundError } from './errors';
import { extractLdapCode, isSchemaRefusal } from './ldapCodes';
import type { SchemaIndex } from './ldapSchema';

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

/** Where each judged hook takes the request in its arguments. */
const AUTHORIZED_REQUEST_AT: Record<AuthorizedHook, number> = {
  ldapaddrequest: 2,
  ldapmodifyrequest: 3,
  ldaprenamerequest: 2,
  ldapdeleterequest: 1,
};

/** The hooks a write launches once its "done" hooks have returned */
type EndHook = 'ldapmodifyend' | 'ldapdeleteend' | 'ldaprenameend';

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

/** The request hooks an operation is judged in, see `ldapActions.authorize` */
type AuthorizedHook =
  | 'ldapaddrequest'
  | 'ldapmodifyrequest'
  | 'ldapdeleterequest'
  | 'ldaprenamerequest';

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
 * No value adds nothing: an empty list is a protocol error for the directory,
 * and ldapts throws on `null` or `undefined`, alone or in a list. Either
 * reached the client as a 500. A replace with no value is how an attribute is
 * cleared, and does not come here.
 */
const unwritable = (value: unknown): boolean => {
  const absent = (v: unknown): boolean => v === null || v === undefined;
  if (Array.isArray(value))
    return value.length === 0 || value.some(item => absent(item));
  return absent(value);
};

function assertHasValue(name: string, value: unknown): void {
  if (unwritable(value))
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
 * Wrap a read failure, turning a refusal of the request's content (see
 * `isSchemaRefusal`) into a 400: the mistake is the client's, and a 500
 * would hide it in logs it cannot read. The base is the DN the client asked
 * to read.
 */
function ldapSearchError(base: string, error: unknown): Error {
  const code = extractLdapCode(error);
  return isSchemaRefusal(code)
    ? ldapRefusal(`The directory refused this read of ${base}`, code!, error)
    : ldapError('LDAP search error', error);
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
    // The attribute names the options give: the plugins compare with these
    for (const [key, value] of Object.entries(this.config))
      if (/_attributes?$/.test(key))
        this.knowAttributeNames(
          [value].flat().filter((v): v is string => typeof v === 'string')
        );

    // Initialize global LDAP query concurrency limiter
    const concurrency = this.config.ldap_concurrency || 10;
    this.queryLimit = pLimit(concurrency);
    this.logger.info(
      `Global LDAP query concurrency limit set to ${concurrency}`
    );

    // Initialize the search cache
    const cacheMax: number =
      typeof this.config.ldap_cache_max === 'string'
        ? parseInt(this.config.ldap_cache_max, 10) || 1000
        : (this.config.ldap_cache_max ?? 1000);
    // `--ldap-cache-ttl` defaults to 0, and 0 means "do not cache": anything
    // writing the directory without going through this process — LSC,
    // ldapmodify, a second replica — leaves this one answering the entry it
    // read before for the whole TTL, and no write path here can know. A
    // deployment that wants the cache turns it on deliberately.
    const ttlSetting = this.config.ldap_cache_ttl;
    const cacheTtlSeconds =
      typeof ttlSetting === 'string'
        ? parseInt(ttlSetting, 10) || 0
        : (ttlSetting ?? 0);
    const cacheTtl = Math.max(cacheTtlSeconds, 0) * 1000; // seconds to ms
    this.cache = new SearchCache({
      max: cacheMax,
      ttl: cacheTtl,
      logger: this.logger,
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
    this.pool = new LdapPool({
      urls: ldapUrls,
      dn: server.config.ldap_dn,
      pwd: server.config.ldap_pwd,
      options,
      poolSize: server.config.ldap_pool_size || 5,
      connectionTtl: (server.config.ldap_connection_ttl || 60) * 1000,
      logger: this.logger,
    });
  }

  /** See {@link LdapPool.ping}. */
  async ping(timeoutMs: number): Promise<void> {
    await this.pool.ping(timeoutMs);
  }

  /** See {@link LdapPool.close}. */
  async close(): Promise<void> {
    await this.pool.close();
  }

  /** The pool as it is, for the metrics */
  poolStats(): {
    busy: number;
    idle: number;
    waiting: number;
    opening: number;
    max: number;
  } {
    return this.pool.stats();
  }

  /**
   * Drop every cached read of `dn`, and of everything below it.
   *
   * Called after each write, so the next read of what just changed goes to
   * the directory. See {@link SearchCache.invalidate}.
   */
  invalidateCache(dn: string): void {
    this.cache.invalidate(dn);
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

  /** See {@link CallerView.readableBy}. */
  async readableBy(dn: string, req?: Request): Promise<boolean> {
    return this.caller.readableBy(dn, req);
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
    const judges = this.parent.hookBus.subscribers(hook).filter(fn => {
      const owner = hookOwner(fn);
      return Boolean(
        owner &&
        this.parent.loadedPlugins[owner.plugin]?.roles?.includes('authz')
      );
    });
    // Only the judges: the other subscribers of the hook run with the
    // operation, which runs every one of them again
    const one = new HookBus({ [hook]: judges });
    await one.chain(hook as 'ldapaddrequest', judged as never);
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

  /** See {@link CallerView.filter}. */
  private filterForCaller(
    value: SearchResult | AsyncGenerator<SearchResult>,
    req?: Request,
    opts?: SearchOptions
  ): SearchResult | AsyncGenerator<SearchResult> | Promise<SearchResult> {
    return this.caller.filter(value, req, opts);
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
    opts = await this.parent.hookBus.chain('ldapsearchopts', opts);
    [base, opts] = await this.parent.hookBus.chain('ldapsearchrequest', [
      base,
      opts,
      req,
    ]);

    // Cache non-paginated, base-scope searches only: they are the common
    // attribute lookups, and one entry is small enough to keep.
    //
    // The lookup sits after the `ldapsearchrequest` hooks on purpose. The
    // authorization plugins refuse by throwing from them, so a cache hit is
    // only ever reached by a request already allowed to read `base`, and the
    // key is built from the base and options those hooks settled on.
    const cacheable =
      this.cache.enabled && !opts.paged && opts.scope === 'base';
    const cacheKey = cacheable ? this.cache.key(base, opts) : '';
    // The write count this read starts at: a write landing between here and
    // the store below would leave what comes back describing a state that no
    // longer holds, and `invalidate` would find nothing to drop. See
    // `SearchCache.generation`.
    const generation = this.cache.generation;
    if (cacheable) {
      const cached = this.cache.get(cacheKey);
      ldapSearchCache.inc({ result: cached ? 'hit' : 'miss' });
      if (cached) {
        this.logger.debug(`LDAP search cache hit: ${digestKey(cacheKey)}`);
        return this.filterForCaller(cached, req, opts);
      }
    }

    // A paged search is a generator: the connection is taken on its first
    // page, so a walk the caller never starts holds none. The hooks above
    // have already run, so a refusal is still answered by `search()`.
    // A closed pool still refuses a paged search at once, as an unpaged one.
    if (opts.paged) {
      this.pool.assertOpen();
      return this.filterForCaller(
        this.pagedSearch(base, opts),
        req,
        opts
      ) as AsyncGenerator<SearchResult>;
    }

    // Acquire connection from pool
    const pooled = await this.pool.acquire();
    try {
      const searched = timedLdap('search', () =>
        pooled.client.search(base, opts)
      )
        .then(dropSelectors)
        .catch(error => {
          throw ldapSearchError(base, error);
        });
      // The hooks are handed the driver's value unawaited, and the chain
      // resolves it: the result is never a Promise after this.
      const res = await this.parent.hookBus.chain(
        'ldapsearchresult',
        searched as unknown as SearchResult
      );

      // Cache non-paginated, base-scope search results.
      //
      // The chain awaits whatever each hook returns, so by here `res` is the
      // resolved result of a non-paginated search and never a Promise: the
      // `res instanceof Promise` guard that used to stand here could not be
      // true, and nothing was ever cached (#166). What the hooks see is
      // untouched — the chain is still handed the unawaited value the driver
      // returned, in the same place as before.
      //
      // A search that fails — noSuchObject on a DN that is not there — threw
      // out of the chain above and never reaches this line, so a missing
      // entry is never cached as missing.
      if (cacheable) {
        const result = res;
        // A write that landed while this read was in flight makes what came
        // back describe the directory as it was before that write, and there
        // is nothing left to drop it: the write's `invalidate` ran when
        // this entry did not exist yet. Storing it now would serve the state
        // it replaced for a whole TTL, so it is answered, not kept.
        if (generation === this.cache.generation) {
          this.cache.set(cacheKey, result);
          this.logger.debug(`LDAP search cached: ${digestKey(cacheKey)}`);
        } else {
          this.logger.debug(
            `LDAP search not cached, a write overtook it: ${digestKey(cacheKey)}`
          );
        }
      }

      return this.filterForCaller(res, req, opts);
    } finally {
      this.pool.release(pooled);
    }
  }

  /**
   * A paged search, opened on its first page: a generator that is never
   * started holds no connection. The pool is taken here, in the generator
   * body, not by `search()`.
   */
  private async *pagedSearch(
    base: string,
    opts: SearchOptions
  ): AsyncGenerator<SearchResult> {
    const pooled = await this.pool.acquire();
    let generator: AsyncGenerator<SearchResult> | undefined;
    let ran = false;
    let spent = 0;
    let result = 'ok';
    try {
      const searched = dropSelectorsPaged(
        pooled.client.searchPaginated(base, opts)
      );
      generator = (await this.parent.hookBus.chain(
        'ldapsearchresult',
        searched as unknown as SearchResult
      )) as unknown as AsyncGenerator<SearchResult>;
      // Timed page by page: between two pages the generator waits on the
      // caller, whose work is not the directory's. A walk the caller leaves
      // early is a walk the directory answered.
      for (;;) {
        const started = process.hrtime.bigint();
        let page: IteratorResult<SearchResult>;
        try {
          ran = true;
          page = await generator.next();
        } catch (err) {
          result = ldapResult(err);
          throw ldapSearchError(base, err);
        } finally {
          spent += secondsSince(started);
        }
        if (page.done) return;
        yield page.value;
      }
    } finally {
      try {
        await generator?.return(undefined);
      } catch {
        // A hook may hand back something that is no generator
      } finally {
        if (ran)
          ldapOperationDuration.observe({ operation: 'search', result }, spent);
        this.pool.release(pooled);
      }
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
    [dn, entry] = await this.parent.hookBus.chain('ldapaddrequest', [
      dn,
      sanitizedEntry,
      req,
    ]);

    const members = membersNamed(entry);

    // Convert to Attribute objects
    const attributes: Attribute[] = [];
    for (const [key, value] of Object.entries(entry)) {
      assertHasValue(key, value);
      const values = (Array.isArray(value) ? value : [value]) as
        string[] | Buffer[];
      attributes.push(
        new Attribute({
          type: key,
          values,
        })
      );
    }

    const pooled = await this.pool.acquire();
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and the cache's generation keeps a read the
      // overtook from putting it back.
      this.cache.invalidate(dn);
      // A group created with members changes their `memberOf`
      for (const member of members) this.cache.invalidate(member);
      await timedLdap('add', () => pooled.client.add(dn, attributes));
      // Drop any cached read of this DN.
      //
      // Not to lift a negative result: a base-scope read of a DN that is not
      // there throws and caches nothing, and an add on a DN that *is* there
      // is refused by the directory. What it covers is the entry read and
      // cached here, then deleted by something else — another replica, LSC,
      // ldapmodify — and re-created through this call, where the cache would
      // otherwise keep answering the entry that used to carry this DN.
      this.cache.invalidate(dn);
      for (const member of members) this.cache.invalidate(member);
      this.parent.hookBus.notify('ldapadddone', dn, entry, changeContext(req));
    } catch (error) {
      throw ldapAddError(dn, error);
    } finally {
      this.pool.release(pooled);
    }
    // After the connection is released, so none is held while subscribers
    // run; a failure is logged and goes no further, the add having succeeded
    await this.parent.hookBus.notifyAndWait(
      'ldapaddafter',
      dn,
      entry,
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
      this.endOperation(done, 'ldapmodifyend', op);
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
    [dn, changes] = await this.parent.hookBus.chain('ldapmodifyrequest', [
      dn,
      changes,
      op,
      req,
    ]);
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
        for (const attr of changes.delete)
          ldapChanges.push(
            new Change({
              operation: 'delete',
              modification: new Attribute({ type: attr, values: [] }),
            })
          );
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
    const invalidate = (): void => {
      this.cache.invalidate(dn);
      this.cache.invalidateMembership(dn, changes);
    };
    if (ldapChanges.length !== 0) {
      const controls = options.permissive
        ? [new Control(PERMISSIVE_MODIFY, { critical: false })]
        : undefined;
      const send = (): Promise<void> =>
        this.pool.withConnection(client =>
          timedLdap('modify', () => client.modify(dn, ldapChanges, controls))
        );
      try {
        // Dropped before the write is issued as well as after it lands. The
        // directory commits somewhere inside this `await`, and the invalidation
        // below runs only once the answer has come back: a read landing in that
        // round trip would find the entry still cached and answer what it held
        // before the write. Dropping it early costs a miss if the write then
        // fails, which is harmless, and the cache's generation keeps a read the
        // overtook from putting it back.
        invalidate();
        try {
          await send();
        } catch (error) {
          // Repaired only once the directory refuses the classes (65), so a
          // write it takes costs no read. The connection is given back before
          // the repair reads: holding it meanwhile could exhaust the pool.
          if (extractLdapCode(error) !== 65) throw error;
          const repair = await this.schema.classRepair(
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
          this.cache.invalidate(dn);
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
          this.parent.hookBus.notifyAndWait(
            'ldapmodifydone',
            dn,
            changes,
            op,
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
      // change it named was dropped while building the request. Nothing
      // reaches the directory and the call still answers, so a translation
      // bug upstream is invisible from the outside. That is worth a line
      // someone will see.
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
        this.parent.hookBus.notifyAndWait(
          'ldapmodifydone',
          dn,
          {},
          op,
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
      this.endOperation(done, 'ldaprenameend', op);
    }
  }

  private async applyRename(
    dn: string,
    newRdn: string,
    req: Request | undefined,
    done: Promise<void>[]
  ): Promise<boolean> {
    [dn, newRdn] = await this.parent.hookBus.chain('ldaprenamerequest', [
      dn,
      newRdn,
      req,
    ]);
    const pooled = await this.pool.acquire();
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and the cache's generation keeps a read the
      // overtook from putting it back.
      this.cache.invalidate(dn);
      this.cache.invalidate(newRdn);
      this.cache.invalidateReferences(dn);
      await timedLdap('rename', () => pooled.client.modifyDN(dn, newRdn));
      // Invalidate both ends. A base-scope read of the old DN would
      // otherwise keep answering the entry that is no longer there, and a
      // read cached under the new DN — of whatever used to carry it — would
      // hide the entry that just took its place. `invalidate` drops the
      // subtree too: renaming a container moves every DN under it. And the
      // directory rewrites what named the old DN — the members' `memberOf`
      // of a renamed group, the references `refint` follows.
      this.cache.invalidate(dn);
      this.cache.invalidate(newRdn);
      this.cache.invalidateReferences(dn);
      done.push(
        this.parent.hookBus.notifyAndWait(
          'ldaprenamedone',
          dn,
          newRdn,
          changeContext(req)
        )
      );
      return true;
    } catch (error) {
      throw ldapRenameError('LDAP rename error', dn, newRdn, error);
    } finally {
      this.pool.release(pooled);
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
    const pooled = await this.pool.acquire();
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and the cache's generation keeps a read the
      // overtook from putting it back.
      this.cache.invalidate(dn);
      this.cache.invalidate(newDn);
      this.cache.invalidateReferences(dn);
      await timedLdap('rename', () => pooled.client.modifyDN(dn, newDn));
      // Invalidate both ends — see rename() above for why both matter.
      this.cache.invalidate(dn);
      this.cache.invalidate(newDn);
      this.cache.invalidateReferences(dn);
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
        this.parent.hookBus.notify(
          'ldaprenamedone',
          dn,
          newDn,
          changeContext(req)
        )
      );
      this.logger.debug(`LDAP move: ${dn} -> ${newDn}`);
      return true;
    } catch (error) {
      throw ldapRenameError('LDAP move error', dn, newDn, error);
    } finally {
      this.pool.release(pooled);
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
      this.endOperation(done, 'ldapdeleteend', op);
    }
  }

  private async applyDelete(
    dn: string | string[],
    req: Request | undefined,
    options: Pick<ModifyOptions, 'context'>,
    done: Promise<void>[]
  ): Promise<boolean> {
    [dn] = await this.parent.hookBus.chain('ldapdeleterequest', [dn, req]);

    await this.pool.withConnection(async client => {
      for (const entry of dn) {
        try {
          // Dropped before the write is issued as well as after it lands. The
          // directory commits somewhere inside this `await`, and the invalidation
          // below runs only once the answer has come back: a read landing in that
          // round trip would find the entry still cached and answer what it held
          // before the write. Dropping it early costs a miss if the write then
          // fails, which is harmless, and the cache's generation keeps a read the
          // overtook from putting it back.
          this.cache.invalidate(entry);
          this.cache.invalidateReferences(entry);
          await timedLdap('delete', () => client.del(entry));
          // Invalidate cache for this DN, and for what named it: a deleted
          // group leaves its members' `memberOf`
          this.cache.invalidate(entry);
          this.cache.invalidateReferences(entry);
        } catch (error) {
          const code = extractLdapCode(error);
          throw code === 32
            ? withCode(new NotFoundError(`Entry ${entry} not found`), code)
            : ldapWriteError('LDAP delete error', entry, error);
        }
        done.push(
          this.parent.hookBus.notifyAndWait(
            'ldapdeletedone',
            entry,
            options.context ?? changeContext(req)
          )
        );
      }
    });
    return true;
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
  private endOperation(done: Promise<void>[], hook: EndHook, op: number): void {
    if (!this.parent.hookBus.has(hook)) return;
    void Promise.all(done).then(() =>
      this.parent.hookBus.notify(hook as 'ldapmodifyend', op)
    );
  }

  opNumber(): number {
    return this.parent.operationSequence++;
  }
}

export default ldapActions;
