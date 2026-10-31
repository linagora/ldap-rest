import { expect } from 'chai';
import type { Request } from 'express';
import type { SearchOptions, SearchResult } from 'ldapts';

import CallerView from '../../../src/lib/ldap/callerView';
import { ForbiddenError } from '../../../src/lib/errors';

const req = { user: 'alice' } as unknown as Request;

const answer = (entries: Array<Record<string, unknown>>): SearchResult =>
  ({
    searchEntries: entries,
    searchReferences: [],
  }) as unknown as SearchResult;

interface Seen {
  options?: SearchOptions;
  base?: string;
  req?: Request;
}

const viewFor = (
  found: SearchResult | Error,
  seen: Seen = {},
  filter: {
    has?: boolean;
    hook?: (
      chunk: SearchResult,
      req?: Request,
      opts?: SearchOptions
    ) => Promise<SearchResult>;
  } = {}
): CallerView =>
  new CallerView({
    search: (options, base, request) => {
      seen.options = options;
      seen.base = base;
      seen.req = request;
      return found instanceof Error
        ? Promise.reject(found)
        : Promise.resolve(found);
    },
    hasFilter: () => filter.has ?? false,
    filter: filter.hook ?? (chunk => Promise.resolve(chunk)),
  });

describe('CallerView', () => {
  describe('readableBy', () => {
    it('lets everyone in when no request asks', async () => {
      const seen: Seen = {};
      expect(
        await viewFor(answer([]), seen).readableBy('uid=alice,dc=x')
      ).to.equal(true);
      expect(seen.base).to.equal(undefined);
    });

    it('reads the entry as the caller, base-scope', async () => {
      const seen: Seen = {};
      expect(
        await viewFor(answer([{ dn: 'uid=alice,dc=x' }]), seen).readableBy(
          'uid=alice,dc=x',
          req
        )
      ).to.equal(true);
      expect(seen.base).to.equal('uid=alice,dc=x');
      expect(seen.req).to.equal(req);
      expect(seen.options).to.deep.include({ scope: 'base', paged: false });
    });

    it('answers absent when the caller read finds nothing', async () => {
      expect(
        await viewFor(answer([])).readableBy('uid=alice,dc=x', req)
      ).to.equal(false);
    });

    it('answers absent on a refusal or a missing entry', async () => {
      for (const error of [
        new ForbiddenError('not for you'),
        Object.assign(new Error('forbidden'), { statusCode: 403 }),
        Object.assign(new Error('no such object'), { code: 32 }),
      ])
        expect(
          await viewFor(error).readableBy('uid=alice,dc=x', req),
          String(error)
        ).to.equal(false);
    });

    it('lets a failure that is not a refusal through', async () => {
      let raised: unknown;
      try {
        await viewFor(new Error('directory down')).readableBy(
          'uid=alice,dc=x',
          req
        );
      } catch (err) {
        raised = err;
      }
      expect((raised as Error).message).to.equal('directory down');
    });
  });

  describe('filter', () => {
    const result = answer([{ dn: 'uid=alice,dc=x' }]);

    it('hands the result through when nothing filters searches', () => {
      const seen: SearchResult[] = [];
      const view = viewFor(
        result,
        {},
        {
          has: false,
          hook: chunk => {
            seen.push(chunk);
            return Promise.resolve(chunk);
          },
        }
      );
      expect(view.filter(result, req)).to.equal(result);
      expect(seen).to.be.empty;
    });

    it('hands each result to the filter, with the caller and options', async () => {
      const seen: Array<[unknown, unknown, unknown]> = [];
      const opts: SearchOptions = { scope: 'base' };
      const filtered = answer([{ dn: 'uid=bob,dc=x' }]);
      const view = viewFor(
        result,
        {},
        {
          has: true,
          hook: (chunk, request, options) => {
            seen.push([chunk, request, options]);
            return Promise.resolve(filtered);
          },
        }
      );
      expect(await view.filter(result, req, opts)).to.equal(filtered);
      expect(seen).to.deep.equal([[result, req, opts]]);
    });

    it('keeps the answer when a subscriber returns nothing', async () => {
      const view = viewFor(
        result,
        {},
        {
          has: true,
          hook: () => Promise.resolve(undefined as unknown as SearchResult),
        }
      );
      expect(await view.filter(result, req)).to.equal(result);
    });

    it('filters a paginated walk chunk by chunk, as it is consumed', async () => {
      const seen: SearchResult[] = [];
      const first = answer([{ dn: 'uid=alice,dc=x' }]);
      const second = answer([{ dn: 'uid=bob,dc=x' }]);
      async function* pages(): AsyncGenerator<SearchResult> {
        yield first;
        yield second;
      }
      const view = viewFor(
        result,
        {},
        {
          has: true,
          hook: chunk => {
            seen.push(chunk);
            return Promise.resolve(chunk);
          },
        }
      );
      const filtered = view.filter(
        pages(),
        req
      ) as AsyncGenerator<SearchResult>;
      expect(seen, 'nothing before the walk starts').to.be.empty;
      expect(await filtered.next()).to.deep.equal({
        value: first,
        done: false,
      });
      expect(seen).to.deep.equal([first]);
      expect(await filtered.next()).to.deep.equal({
        value: second,
        done: false,
      });
      expect(seen).to.deep.equal([first, second]);
    });
  });
});
