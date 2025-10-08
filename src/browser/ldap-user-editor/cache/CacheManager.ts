/**
 * Simple in-memory cache manager with LRU eviction
 * Prevents excessive API calls when navigating the organization tree
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  accessCount: number;
}

export interface CacheOptions {
  /**
   * Time to live in milliseconds (default: 5 minutes)
   */
  ttl?: number;
  /**
   * Maximum number of entries (default: 200)
   */
  maxEntries?: number;
}

export class CacheManager {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private ttl: number;
  private maxEntries: number;

  constructor(options: CacheOptions = {}) {
    this.ttl = options.ttl ?? 5 * 60 * 1000; // 5 minutes default
    this.maxEntries = options.maxEntries ?? 200; // 200 entries max
  }

  /**
   * Get an item from cache
   * Returns null if not found or expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp >= this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Update access count for LRU
    entry.accessCount++;
    entry.timestamp = Date.now();
    return entry.data;
  }

  /**
   * Set an item in cache
   * Evicts least recently used items if cache is full
   */
  set<T>(key: string, data: T): void {
    // If cache is full, evict LRU entry
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      accessCount: 0,
    });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Invalidate a specific key
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all keys matching a pattern
   * Pattern can contain wildcards (*)
   */
  invalidatePattern(pattern: string): void {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    ttl: number;
    keys: string[];
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxEntries,
      ttl: this.ttl,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    let lruKey: string | null = null;
    let lruTime = Infinity;
    let lruCount = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      // Prioritize by access count, then by timestamp
      if (
        entry.accessCount < lruCount ||
        (entry.accessCount === lruCount && entry.timestamp < lruTime)
      ) {
        lruKey = key;
        lruTime = entry.timestamp;
        lruCount = entry.accessCount;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
    }
  }

  /**
   * Clean expired entries
   * Should be called periodically
   */
  cleanExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp >= this.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }
}
