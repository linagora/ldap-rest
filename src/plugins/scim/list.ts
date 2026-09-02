/**
 * @module plugins/scim/list
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Server-side pagination for the SCIM list endpoints (RFC 7644 §3.4.2.4).
 *
 * A SCIM list is a window — `startIndex` (1-based) and `count` — over the full
 * set of matching resources, plus the size of that set as `totalResults`. LDAP
 * has no equivalent of an offset, so the window is cut while walking a paged
 * search: entries before `startIndex` are counted and dropped, `count` of them
 * are kept, and the remainder is counted so `totalResults` is real.
 *
 * Only the requested page is ever materialised, so the cost of a list is the
 * page, not the directory. Walking still has to reach the end of the result
 * set to count it, which is bounded by `maxScanned`: beyond that we answer the
 * `tooMany` RFC 7644 §3.12 provides for a filter yielding "many more results
 * than the server is willing to calculate or process".
 */
import type ldapActions from '../../lib/ldapActions';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import type { DmRequest } from '../../lib/auth/base';

import { scimTooMany, extractLdapCode } from './errors';

export interface PagedSearch {
  ldap: ldapActions;
  base: string;
  filter: string;
  attributes: string[];
  /** 1-based index of the first resource to return. */
  startIndex: number;
  /** Page size. Zero is legal and asks for `totalResults` only. */
  count: number;
  /** Upper bound on entries walked before answering `tooMany`. */
  maxScanned: number;
  req?: DmRequest;
}

export interface PagedResult {
  entries: AttributesList[];
  totalResults: number;
}

/** How many entries to ask the directory for at a time. */
function pageSizeFor(count: number): number {
  // Big enough that a default-sized page is one round-trip, small enough that
  // counting a large result set does not build huge intermediate arrays.
  return Math.min(500, Math.max(count, 100));
}

export async function pagedSearch(opts: PagedSearch): Promise<PagedResult> {
  const first = Math.max(0, opts.startIndex - 1);
  const entries: AttributesList[] = [];
  let scanned = 0;

  let generator: AsyncGenerator<SearchResult>;
  try {
    generator = (await opts.ldap.search(
      {
        filter: opts.filter,
        scope: 'sub',
        paged: { pageSize: pageSizeFor(opts.count) },
        attributes: opts.attributes,
        // The walk is bounded by maxScanned, not by the directory: a server
        // size limit would truncate the count instead of reporting it.
        sizeLimit: 0,
      },
      opts.base,
      opts.req
    )) as AsyncGenerator<SearchResult>;
  } catch (err) {
    // A base that does not exist yet is an empty collection, not an error:
    // the equivalent single-resource lookups answer 404 on their own.
    if (extractLdapCode(err) === 32) return { entries: [], totalResults: 0 };
    throw err;
  }

  try {
    for await (const page of generator) {
      for (const entry of page.searchEntries || []) {
        if (scanned >= first && entries.length < opts.count) {
          entries.push(entry as AttributesList);
        }
        scanned++;
        if (scanned > opts.maxScanned) {
          throw scimTooMany(
            `Query matched more than ${opts.maxScanned} resources; narrow it with a filter or raise --scim-max-scanned`
          );
        }
      }
    }
  } catch (err) {
    // sizeLimitExceeded (4): the directory itself refused to walk that far.
    if (extractLdapCode(err) === 4) {
      throw scimTooMany(
        'The directory refused the query with sizeLimitExceeded; narrow it with a filter or raise the directory size limit'
      );
    }
    throw err;
  }

  return { entries, totalResults: scanned };
}
