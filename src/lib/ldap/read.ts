/**
 * The read half of the LDAP operation pipeline: the search hooks and the
 * caller projection, behind the `ldapActions` façade.
 */
import type { Request } from 'express';
import type { SearchOptions, SearchResult } from 'ldapts';

import type { Hooks } from '../../hooks';
import { hookOwner } from '../utils';
import HookBus from '../hookBus';
import { currentRequest } from '../requestContext';
import {
  ldapOperationDuration,
  ldapResult,
  ldapSearchCache,
  secondsSince,
  timedLdap,
} from '../metrics';
import type { AttributesList, ModifyRequest } from '../ldapActions';

import { digestKey } from './searchCache';
import { setDn } from './operations';
import { dropSelectors, dropSelectorsPaged, ldapSearchError } from './errors';
import type { LdapHost } from './operations';

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

/** Where each judged hook takes the request in its arguments. */
const AUTHORIZED_REQUEST_AT: Record<AuthorizedHook, number> = {
  ldapaddrequest: 2,
  ldapmodifyrequest: 3,
  ldaprenamerequest: 2,
  ldapdeleterequest: 1,
};

/** The request hooks an operation is judged in, see `ldapActions.authorize` */
export type AuthorizedHook =
  | 'ldapaddrequest'
  | 'ldapmodifyrequest'
  | 'ldapdeleterequest'
  | 'ldaprenamerequest';

/** See {@link CallerView.filter}. */
function filterForCaller(
  host: LdapHost,
  value: SearchResult | AsyncGenerator<SearchResult>,
  req?: Request,
  opts?: SearchOptions
): SearchResult | AsyncGenerator<SearchResult> | Promise<SearchResult> {
  return host.caller.filter(value, req, opts);
}

export async function authorize<H extends AuthorizedHook>(
  host: LdapHost,
  hook: H,
  args: Parameters<NonNullable<Hooks[H]>>[0]
): Promise<void> {
  // The request being served, when none is named, as for the operation
  const given = [...(args as unknown[])];
  // Judged under the names the operation will give them
  if (hook === 'ldapaddrequest')
    await host.schema.canonicalAttributes(given[1] as AttributesList);
  if (hook === 'ldapmodifyrequest')
    await host.schema.canonicalChanges(given[1] as ModifyRequest);
  const at = AUTHORIZED_REQUEST_AT[hook];
  given[at] ??= currentRequest();
  // The DNs as the operation completes them before its hooks see them
  const [target, ...rest] = given;
  const judged: unknown[] =
    hook === 'ldapdeleterequest'
      ? [[target].flat().map(dn => setDn(host, String(dn))), ...rest]
      : [setDn(host, String(target)), ...rest];
  if (hook === 'ldaprenamerequest') judged[1] = setDn(host, String(judged[1]));
  const judges = host.parent.hookBus.subscribers(hook).filter(fn => {
    const owner = hookOwner(fn);
    return Boolean(
      owner && host.parent.loadedPlugins[owner.plugin]?.roles?.includes('authz')
    );
  });
  // Only the judges: the other subscribers of the hook run with the
  // operation, which runs every one of them again
  const one = new HookBus({ [hook]: judges });
  await one.chain(hook as 'ldapaddrequest', judged as never);
}

export async function search(
  host: LdapHost,
  options: SearchOptions,
  base: string = host.base,
  req?: Request
): Promise<SearchResult | AsyncGenerator<SearchResult>> {
  req ??= currentRequest();
  let opts = {
    ...defaultSearchOptions,
    ...options,
  };
  opts = await host.parent.hookBus.chain('ldapsearchopts', opts);
  [base, opts] = await host.parent.hookBus.chain('ldapsearchrequest', [
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
  const cacheable = host.cache.enabled && !opts.paged && opts.scope === 'base';
  const cacheKey = cacheable ? host.cache.key(base, opts) : '';
  // The write count this read starts at: a write landing between here and
  // the store below would leave what comes back describing a state that no
  // longer holds, and `invalidate` would find nothing to drop. See
  // `SearchCache.generation`.
  const generation = host.cache.generation;
  if (cacheable) {
    const cached = host.cache.get(cacheKey);
    ldapSearchCache.inc({ result: cached ? 'hit' : 'miss' });
    if (cached) {
      host.logger.debug(`LDAP search cache hit: ${digestKey(cacheKey)}`);
      return filterForCaller(host, cached, req, opts);
    }
  }

  // A paged search is a generator: the connection is taken on its first
  // page, so a walk the caller never starts holds none. The hooks above
  // have already run, so a refusal is still answered by `search()`.
  // A closed pool still refuses a paged search at once, as an unpaged one.
  if (opts.paged) {
    host.pool.assertOpen();
    return filterForCaller(
      host,
      pagedSearch(host, base, opts),
      req,
      opts
    ) as AsyncGenerator<SearchResult>;
  }

  // Acquire connection from pool
  const pooled = await host.pool.acquire();
  try {
    const searched = timedLdap('search', () => pooled.client.search(base, opts))
      .then(dropSelectors)
      .catch(error => {
        throw ldapSearchError(base, error);
      });
    // The hooks are handed the driver's value unawaited, and the chain
    // resolves it: the result is never a Promise after the chain.
    const res = await host.parent.hookBus.chain(
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
      if (generation === host.cache.generation) {
        host.cache.set(cacheKey, result);
        host.logger.debug(`LDAP search cached: ${digestKey(cacheKey)}`);
      } else {
        host.logger.debug(
          `LDAP search not cached, a write overtook it: ${digestKey(cacheKey)}`
        );
      }
    }

    return filterForCaller(host, res, req, opts);
  } finally {
    host.pool.release(pooled);
  }
}

/**
 * A paged search, opened on its first page: a generator that is never
 * started holds no connection. The pool is taken here, in the generator
 * body, not by `search()`.
 */
async function* pagedSearch(
  host: LdapHost,
  base: string,
  opts: SearchOptions
): AsyncGenerator<SearchResult> {
  const pooled = await host.pool.acquire();
  let generator: AsyncGenerator<SearchResult> | undefined;
  let ran = false;
  let spent = 0;
  let result = 'ok';
  try {
    const searched = dropSelectorsPaged(
      pooled.client.searchPaginated(base, opts)
    );
    generator = (await host.parent.hookBus.chain(
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
        throw err;
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
      host.pool.release(pooled);
    }
  }
}
