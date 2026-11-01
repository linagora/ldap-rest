/**
 * The search cache: what a base-scope read answered, keyed by the search
 * that asked, dropped when a write changes the directory under it.
 */
import { createHash } from 'node:crypto';

import type { SearchOptions, SearchResult } from 'ldapts';
import { LRUCache } from 'lru-cache';

export interface CacheLogger {
  info(message: string): void;
}

export interface SearchCacheOptions {
  max: number;
  /** Milliseconds; 0 switches the cache off. */
  ttl: number;
  logger: CacheLogger;
}

/**
 * Field separator of a search-cache key.
 *
 * NUL cannot appear unescaped in a DN (RFC 4514 writes it `\00`) nor in an
 * LDAP filter (RFC 4515 writes it `\00` too), so `invalidate` can split
 * the base DN back out of a key instead of guessing where it ends.
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
export const digestKey = (key: string): string =>
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
export const membersNamed = (
  attributes: Record<string, unknown> | undefined
): string[] =>
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

/** The parts of a change that name members, as `applyModify` reads them. */
type MembershipChanges = {
  add?: Record<string, unknown>;
  replace?: Record<string, unknown>;
  delete?: string[] | Record<string, unknown>;
};

export default class SearchCache {
  readonly enabled: boolean;
  private readonly logger: CacheLogger;
  private readonly searchCache: LRUCache<string, SearchResult>;
  /**
   * How many writes this cache has seen.
   *
   * A read can be overtaken by a write: the write lands and `invalidate`
   * finds nothing to drop, because the read has not stored its answer yet —
   * and the read then stores what it read *before* the write, an entry
   * nothing will drop until its TTL runs out. A search remembers the count
   * it started at and stores only if no write happened in between, so a read
   * a write overtook costs a cache entry, never a stale answer.
   *
   * The count is per cache and per write, not per DN: a write to another
   * branch keeps a concurrent read out of the cache too. That is hit rate
   * given up, not freshness.
   */
  private cacheGeneration = 0;

  constructor(options: SearchCacheOptions) {
    this.logger = options.logger;
    this.enabled = options.ttl > 0;
    this.searchCache = new LRUCache<string, SearchResult>({
      max: options.max,
      // An LRU built with `ttl: 0` expires nothing ever, which is the
      // opposite of what 0 asks for: the cache is switched off through
      // `enabled`, and then nothing is ever stored in it.
      ttl: this.enabled ? options.ttl : undefined,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });
    this.logger.info(
      this.enabled
        ? `LDAP search cache initialized: max=${options.max}, ttl=${options.ttl / 1000}s`
        : 'LDAP search cache disabled (--ldap-cache-ttl=0)'
    );
  }

  get generation(): number {
    return this.cacheGeneration;
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
  key(base: string, opts: SearchOptions): string {
    const sortedAttrs = this.getAttributeSignature(opts.attributes);
    const bufferAttrs = opts.explicitBufferAttributes?.length
      ? JSON.stringify([...opts.explicitBufferAttributes].sort())
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

  /** The cached answer, as a copy the caller may edit. */
  get(key: string): SearchResult | undefined {
    const cached = this.searchCache.get(key);
    return cached ? cloneSearchResult(cached) : undefined;
  }

  /** Store a copy of the answer; later callers cannot edit what was stored. */
  set(key: string, result: SearchResult): void {
    this.searchCache.set(key, cloneSearchResult(result));
  }

  /**
   * Drop every cached read of `dn`, and of everything below it.
   *
   * Called after each write, so the next read of what just changed goes to
   * the directory. It compares DNs the way the directory does (see
   * {@link foldDn}), so a write spelling a DN differently from the read that
   * cached it still drops it; and it drops the subtree, because a rename or
   * a move re-parents a whole branch in one operation — renaming an
   * organization changes the DN of every entry under it — leaving the cached
   * reads of those children filed under DNs that no longer exist. A leaf has
   * nothing below it and the extra test costs nothing.
   */
  invalidate(dn: string): void {
    if (!this.enabled) return;
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
   * cached reads are what {@link invalidate} cannot find, and they name
   * the entry written: the members of a group name it in their `memberOf`.
   * A member a write adds names it only once the write has landed; the
   * caller drops those by their own DN.
   *
   * Every attribute is looked at, not `memberOf` alone: which attributes an
   * overlay maintains is the deployment's configuration. A read naming `dn`
   * for another reason is dropped too, which costs a miss.
   */
  invalidateReferences(dn: string): void {
    if (!this.enabled) return;
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

  /**
   * Drop what a change of a group's members makes stale: the group, what
   * names it, and the members the change names. A replace or a delete of
   * every value removes members the change no longer names; their cached
   * reads are found by the group's DN in their `memberOf`.
   */
  invalidateMembership(dn: string, changes: MembershipChanges): void {
    const membershipChanged = [changes.add, changes.replace, changes.delete]
      .flatMap(part => (Array.isArray(part) ? part : Object.keys(part ?? {})))
      .some(isMembershipAttribute);
    if (!membershipChanged) return;
    this.invalidateReferences(dn);
    for (const part of [changes.add, changes.replace, changes.delete])
      for (const member of membersNamed(Array.isArray(part) ? {} : part))
        this.invalidate(member);
  }

  /**
   * Get a sorted signature for an attribute list.
   *
   * The signature is JSON, not a separator-joined string: an attribute
   * description may contain any character that could stand for a separator,
   * so joining would let `['cn|mail']` and `['cn', 'mail']` share one.
   */
  private getAttributeSignature(attributes: string[] | undefined): string {
    if (!attributes || attributes.length === 0) return '*';
    return JSON.stringify([...attributes].sort());
  }
}
