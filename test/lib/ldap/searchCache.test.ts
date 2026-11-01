import { expect } from 'chai';
import type { SearchOptions, SearchResult } from 'ldapts';

import SearchCache, {
  digestKey,
  membersNamed,
  type CacheLogger,
} from '../../../src/lib/ldap/searchCache';

const silentLogger: CacheLogger = { info: () => undefined };

const cacheFor = (ttl = 60_000): SearchCache =>
  new SearchCache({ max: 100, ttl, logger: silentLogger });

const answer = (...entries: Array<Record<string, unknown>>): SearchResult => ({
  searchEntries: entries.map(entry => ({
    dn: 'dc=example,dc=com',
    ...entry,
  })) as unknown as SearchResult['searchEntries'],
  searchReferences: [],
});

const baseSearch = (): SearchOptions => ({
  scope: 'base',
  filter: '(objectClass=*)',
  attributes: ['*'],
});

describe('SearchCache', () => {
  describe('keys', () => {
    it('keys a search by the base and by what changes its answer', () => {
      const cache = cacheFor();
      const key = cache.key('uid=alice,dc=example,dc=com', {
        ...baseSearch(),
        attributes: ['cn', 'mail'],
      });
      expect(
        cache.key('uid=alice,dc=example,dc=com', {
          ...baseSearch(),
          attributes: ['mail', 'cn'],
        })
      ).to.equal(key);
      expect(cache.key('uid=bob,dc=example,dc=com', baseSearch())).to.not.equal(
        key
      );
      expect(
        cache.key('uid=alice,dc=example,dc=com', {
          ...baseSearch(),
          scope: 'sub',
        })
      ).to.not.equal(key);
      expect(
        cache.key('uid=alice,dc=example,dc=com', {
          ...baseSearch(),
          filter: '(uid=alice)',
        })
      ).to.not.equal(key);
    });

    it('does not merge an attribute name holding a separator with two names', () => {
      const cache = cacheFor();
      const key = (attributes: string[]): string =>
        cache.key('uid=jdoe,dc=example,dc=com', {
          scope: 'base',
          attributes,
        });

      expect(key(['cn|mail'])).to.not.equal(key(['cn', 'mail']));
    });

    it('does not merge an attribute name holding a comma with two names', () => {
      const cache = cacheFor();
      const key = (attributes: string[]): string =>
        cache.key('uid=jdoe,dc=example,dc=com', {
          scope: 'base',
          attributes,
        });

      expect(key(['a,b'])).to.not.equal(key(['a', 'b']));
    });

    it('does not merge a name that looks like a JSON list with one element', () => {
      const cache = cacheFor();
      const key = (attributes: string[]): string =>
        cache.key('uid=jdoe,dc=example,dc=com', {
          scope: 'base',
          attributes,
        });

      expect(key(['["cn"]'])).to.not.equal(key(['cn']));
    });

    it('does not merge buffer attribute names holding a comma', () => {
      const cache = cacheFor();
      const key = (explicitBufferAttributes: string[]): string =>
        cache.key('uid=jdoe,dc=example,dc=com', {
          scope: 'base',
          explicitBufferAttributes,
        });

      expect(key(['a,b'])).to.not.equal(key(['a', 'b']));
    });

    it('digests a key without carrying its content', () => {
      expect(digestKey('uid=alice,dc=example,dc=com')).to.have.length(12);
      expect(digestKey('uid=alice,dc=example,dc=com')).to.equal(
        digestKey('uid=alice,dc=example,dc=com')
      );
      expect(digestKey('uid=alice,dc=example,dc=com')).to.not.equal(
        digestKey('uid=bob,dc=example,dc=com')
      );
    });
  });

  describe('answers', () => {
    it('stores and returns copies the caller may edit', () => {
      const cache = cacheFor();
      const key = 'a-key';
      const stored = answer({ member: ['uid=alice,dc=example,dc=com'] });
      cache.set(key, stored);
      const first = cache.get(key);
      expect(first?.searchEntries[0].member).to.deep.equal([
        'uid=alice,dc=example,dc=com',
      ]);
      (first!.searchEntries[0].member as string[]).push(
        'uid=bob,dc=example,dc=com'
      );
      expect(cache.get(key)?.searchEntries[0].member).to.deep.equal([
        'uid=alice,dc=example,dc=com',
      ]);
      (stored.searchEntries[0].member as string[]).push(
        'uid=carol,dc=example,dc=com'
      );
      expect(cache.get(key)?.searchEntries[0].member).to.deep.equal([
        'uid=alice,dc=example,dc=com',
      ]);
    });

    it('keeps the generation moving with each invalidation', () => {
      const cache = cacheFor();
      expect(cache.generation).to.equal(0);
      cache.invalidate('uid=alice,dc=example,dc=com');
      expect(cache.generation).to.equal(1);
      cache.invalidateReferences('uid=alice,dc=example,dc=com');
      expect(cache.generation).to.equal(2);
      cache.invalidateMembership('cn=sales,dc=example,dc=com', {
        add: { member: ['uid=alice,dc=example,dc=com'] },
      });
      expect(cache.generation).to.equal(4);
    });

    it('does not move the generation while the cache is off', () => {
      const cache = cacheFor(0);
      expect(cache.enabled).to.equal(false);
      cache.invalidate('uid=alice,dc=example,dc=com');
      expect(cache.generation).to.equal(0);
    });
  });

  describe('invalidation', () => {
    it('drops the base and its subtree, however the DN is spelled', () => {
      const cache = cacheFor();
      const alice = 'uid=Alice,ou=People,dc=Example,dc=Com';
      const child = 'cn=Child,uid=Alice,ou=People,dc=Example,dc=Com';
      const bob = 'uid=Bob,ou=People,dc=Example,dc=Com';
      cache.set(cache.key(alice, baseSearch()), answer({}));
      cache.set(cache.key(child, baseSearch()), answer({}));
      cache.set(cache.key(bob, baseSearch()), answer({}));

      cache.invalidate('uid=alice, ou=people, dc=example, dc=com');

      expect(cache.get(cache.key(alice, baseSearch()))).to.equal(undefined);
      expect(cache.get(cache.key(child, baseSearch()))).to.equal(undefined);
      expect(cache.get(cache.key(bob, baseSearch()))).to.not.equal(undefined);
    });

    for (const write of [
      'uid=jdo\\65,ou=users,dc=example,dc=com',
      '0.9.2342.19200300.100.1.1=jdoe,ou=users,dc=example,dc=com',
      'uid=jdoe;ou=users;dc=example;dc=com',
      'uid="jdoe",ou=users,dc=example,dc=com',
    ])
      it(`drops the cached reads of a write spelled ${write}`, () => {
        const cache = cacheFor();
        const read = 'uid=jdoe,ou=users,dc=example,dc=com';
        cache.set(cache.key(read, baseSearch()), answer({}));

        cache.invalidate(write);

        expect(cache.get(cache.key(read, baseSearch()))).to.equal(undefined);
      });

    it('drops a cached read when the write names the RDN type by its OID', () => {
      const cache = cacheFor();
      const cached = 'cn=jdoe,ou=users,dc=example,dc=com';
      cache.set(cache.key(cached, baseSearch()), answer({}));

      cache.invalidate('2.5.4.3=jdoe,ou=users,dc=example,dc=com');

      expect(cache.get(cache.key(cached, baseSearch()))).to.equal(undefined);
    });

    it('drops a cached read when the write reorders a multi-valued RDN', () => {
      const cache = cacheFor();
      const cached = 'cn=jdoe+uid=1000,ou=users,dc=example,dc=com';
      cache.set(cache.key(cached, baseSearch()), answer({}));

      cache.invalidate('uid=1000+cn=jdoe,ou=users,dc=example,dc=com');

      expect(cache.get(cache.key(cached, baseSearch()))).to.equal(undefined);
    });

    it('drops a cached read naming the entry under another spelling', () => {
      const cache = cacheFor();
      const group = 'cn=group,dc=example,dc=com';
      const member = 'uid=jdoe,ou=users,dc=example,dc=com';
      cache.set(cache.key(group, baseSearch()), answer({ member }));

      cache.invalidateReferences('uid=jdo\\65,ou=users,dc=example,dc=com');

      expect(cache.get(cache.key(group, baseSearch()))).to.equal(undefined);
    });

    it('drops reads that name a written DN, or an entry below it', () => {
      const cache = cacheFor();
      const group = 'cn=Sales,ou=Groups,dc=Example,dc=Com';
      const child = 'cn=EMEA,cn=Sales,ou=Groups,dc=Example,dc=Com';
      const alice = 'uid=Alice,ou=People,dc=Example,dc=Com';
      const bob = 'uid=Bob,ou=People,dc=Example,dc=Com';
      cache.set(cache.key(alice, baseSearch()), answer({ memberOf: [group] }));
      cache.set(cache.key(bob, baseSearch()), answer({ memberOf: [child] }));

      cache.invalidateReferences(group);

      expect(cache.get(cache.key(alice, baseSearch()))).to.equal(undefined);
      expect(cache.get(cache.key(bob, baseSearch()))).to.equal(undefined);
    });
  });

  describe('membership invalidation (#374)', () => {
    const group = 'cn=Sales,ou=Groups,dc=Example,dc=Com';
    const alice = 'uid=Alice,ou=People,dc=Example,dc=Com';

    it('drops the read of a member a change adds', () => {
      const cache = cacheFor();
      cache.set(cache.key(alice, baseSearch()), answer({ memberOf: [] }));

      cache.invalidateMembership(group, { add: { member: [alice] } });

      expect(cache.get(cache.key(alice, baseSearch()))).to.equal(undefined);
    });

    it('drops the reads of members a replace no longer names', () => {
      const cache = cacheFor();
      cache.set(cache.key(alice, baseSearch()), answer({ memberOf: [group] }));

      cache.invalidateMembership(group, { replace: { member: [] } });

      expect(cache.get(cache.key(alice, baseSearch()))).to.equal(undefined);
    });

    it('leaves reads alone when the change touches no membership', () => {
      const cache = cacheFor();
      cache.set(cache.key(alice, baseSearch()), answer({ memberOf: [group] }));

      cache.invalidateMembership(group, { replace: { description: 'x' } });

      expect(cache.get(cache.key(alice, baseSearch()))).to.not.equal(undefined);
    });
  });

  describe('members named by a change', () => {
    it('reads member and uniqueMember, in any case', () => {
      expect(
        membersNamed({
          Member: ['uid=alice,dc=example,dc=com'],
          UNIQUEMEMBER: 'uid=bob,dc=example,dc=com',
          description: 'not a member',
        })
      ).to.deep.equal([
        'uid=alice,dc=example,dc=com',
        'uid=bob,dc=example,dc=com',
      ]);
    });
  });
});
