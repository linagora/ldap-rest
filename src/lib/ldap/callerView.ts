/**
 * The directory as one caller sees it: whether a route may tell them an
 * entry exists, and what the `ldapsearchfilter` hooks leave of a result.
 */
import type { Request } from 'express';
import type { SearchOptions, SearchResult } from 'ldapts';

import { isAuthzRefusal } from '../errors';
import { extractLdapCode } from '../ldapCodes';
import { currentRequest } from '../requestContext';

export interface CallerViewOptions {
  /** Run a search for the caller who asks. */
  search: (
    options: SearchOptions,
    base: string,
    req?: Request
  ) => Promise<SearchResult | AsyncGenerator<SearchResult>>;
  /** Whether any plugin filters search results. */
  hasFilter: () => boolean;
  /** Hand one chunk to `ldapsearchfilter`. */
  filter: (
    chunk: SearchResult,
    req?: Request,
    opts?: SearchOptions
  ) => Promise<SearchResult>;
}

export default class CallerView {
  private readonly search: CallerViewOptions['search'];
  private readonly hasFilter: CallerViewOptions['hasFilter'];
  private readonly filterHook: CallerViewOptions['filter'];

  constructor(options: CallerViewOptions) {
    this.search = options.search;
    this.hasFilter = options.hasFilter;
    this.filterHook = options.filter;
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
   * Hand a search result to `ldapsearchfilter`, which may drop entries the
   * caller is not allowed to see.
   *
   * Applied on every return path of `search`, and deliberately after the
   * cache: `ldapsearchresult` fires before caching and knows no request, so
   * what it removed for one caller would be served to the next. A paginated
   * search is filtered chunk by chunk, as it is consumed.
   */
  filter(
    value: SearchResult | AsyncGenerator<SearchResult>,
    req?: Request,
    opts?: SearchOptions
  ): SearchResult | AsyncGenerator<SearchResult> | Promise<SearchResult> {
    if (!this.hasFilter()) return value;
    const one = async (chunk: SearchResult): Promise<SearchResult> => {
      // A subscriber that returns nothing must not turn the answer into one.
      return (await this.filterHook(chunk, req, opts)) ?? chunk;
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
}
