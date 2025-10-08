import { expect } from 'chai';
import { CacheManager } from '../../src/browser/ldap-user-editor/cache/CacheManager';

describe('Browser CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager({ ttl: 1000, maxEntries: 5 });
  });

  afterEach(() => {
    cache.clear();
  });

  describe('Basic operations', () => {
    it('should set and get a value', () => {
      cache.set('key1', { data: 'value1' });
      const result = cache.get<{ data: string }>('key1');
      expect(result).to.deep.equal({ data: 'value1' });
    });

    it('should return null for non-existent key', () => {
      const result = cache.get('nonexistent');
      expect(result).to.be.null;
    });

    it('should check if key exists', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).to.be.true;
      expect(cache.has('nonexistent')).to.be.false;
    });

    it('should handle different data types', () => {
      cache.set('string', 'hello');
      cache.set('number', 42);
      cache.set('object', { a: 1, b: 2 });
      cache.set('array', [1, 2, 3]);
      cache.set('boolean', true);

      expect(cache.get('string')).to.equal('hello');
      expect(cache.get('number')).to.equal(42);
      expect(cache.get('object')).to.deep.equal({ a: 1, b: 2 });
      expect(cache.get('array')).to.deep.equal([1, 2, 3]);
      expect(cache.get('boolean')).to.equal(true);
    });
  });

  describe('Invalidation', () => {
    it('should invalidate a specific key', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.invalidate('key1');

      expect(cache.get('key1')).to.be.null;
      expect(cache.get('key2')).to.equal('value2');
    });

    it('should invalidate keys matching pattern', () => {
      cache.set('/api/users/1', { id: 1 });
      cache.set('/api/users/2', { id: 2 });
      cache.set('/api/groups/1', { id: 1 });

      cache.invalidatePattern('/api/users/*');

      expect(cache.get('/api/users/1')).to.be.null;
      expect(cache.get('/api/users/2')).to.be.null;
      expect(cache.get('/api/groups/1')).to.deep.equal({ id: 1 });
    });

    it('should invalidate with wildcard at start', () => {
      cache.set('foo/bar', 'value1');
      cache.set('baz/bar', 'value2');
      cache.set('foo/baz', 'value3');

      cache.invalidatePattern('*/bar');

      expect(cache.get('foo/bar')).to.be.null;
      expect(cache.get('baz/bar')).to.be.null;
      expect(cache.get('foo/baz')).to.equal('value3');
    });

    it('should clear all cache', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      cache.clear();

      expect(cache.get('key1')).to.be.null;
      expect(cache.get('key2')).to.be.null;
      expect(cache.get('key3')).to.be.null;
    });
  });

  describe('TTL expiration', () => {
    it('should return null for expired entries', async () => {
      const shortCache = new CacheManager({ ttl: 50 });
      shortCache.set('key1', 'value1');

      expect(shortCache.get('key1')).to.equal('value1');

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(shortCache.get('key1')).to.be.null;
    });

    it('should update timestamp on get', async () => {
      const shortCache = new CacheManager({ ttl: 100 });
      shortCache.set('key1', 'value1');

      // Access after 50ms
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(shortCache.get('key1')).to.equal('value1');

      // Access again after another 50ms (total 100ms from set, but 50ms from last get)
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(shortCache.get('key1')).to.equal('value1');

      // Wait 100ms more, should be expired now
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(shortCache.get('key1')).to.be.null;
    });

    it('should clean expired entries', async () => {
      const shortCache = new CacheManager({ ttl: 50 });
      shortCache.set('key1', 'value1');
      shortCache.set('key2', 'value2');

      await new Promise(resolve => setTimeout(resolve, 100));

      const cleaned = shortCache.cleanExpired();
      expect(cleaned).to.equal(2);
      expect(shortCache.get('key1')).to.be.null;
      expect(shortCache.get('key2')).to.be.null;
    });
  });

  describe('LRU eviction', () => {
    it('should evict LRU entry when max size is reached', () => {
      const lruCache = new CacheManager({ maxEntries: 3 });

      lruCache.set('key1', 'value1');
      lruCache.set('key2', 'value2');
      lruCache.set('key3', 'value3');

      // Access key1 to make it more recently used
      lruCache.get('key1');

      // Add a new entry, should evict key2 (least recently used)
      lruCache.set('key4', 'value4');

      expect(lruCache.get('key1')).to.equal('value1');
      expect(lruCache.get('key2')).to.be.null; // Evicted
      expect(lruCache.get('key3')).to.equal('value3');
      expect(lruCache.get('key4')).to.equal('value4');
    });

    it('should not evict when updating existing key', () => {
      const lruCache = new CacheManager({ maxEntries: 3 });

      lruCache.set('key1', 'value1');
      lruCache.set('key2', 'value2');
      lruCache.set('key3', 'value3');

      // Update key1
      lruCache.set('key1', 'new-value1');

      expect(lruCache.get('key1')).to.equal('new-value1');
      expect(lruCache.get('key2')).to.equal('value2');
      expect(lruCache.get('key3')).to.equal('value3');
    });
  });

  describe('Statistics', () => {
    it('should return cache stats', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const stats = cache.getStats();

      expect(stats.size).to.equal(2);
      expect(stats.maxSize).to.equal(5);
      expect(stats.ttl).to.equal(1000);
      expect(stats.keys).to.have.members(['key1', 'key2']);
    });

    it('should update size when entries are added/removed', () => {
      cache.set('key1', 'value1');
      expect(cache.getStats().size).to.equal(1);

      cache.set('key2', 'value2');
      expect(cache.getStats().size).to.equal(2);

      cache.invalidate('key1');
      expect(cache.getStats().size).to.equal(1);

      cache.clear();
      expect(cache.getStats().size).to.equal(0);
    });
  });

  describe('Default configuration', () => {
    it('should use default TTL and max entries', () => {
      const defaultCache = new CacheManager();
      const stats = defaultCache.getStats();

      expect(stats.ttl).to.equal(5 * 60 * 1000); // 5 minutes
      expect(stats.maxSize).to.equal(200);
    });
  });
});
