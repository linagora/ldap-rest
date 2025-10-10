/**
 * LDAP User Editor - API Client
 */

import type { Config, LdapUser, PointerOption, Schema } from '../types';
import { CacheManager } from '../cache/CacheManager';

export class UserApiClient {
  private baseUrl: string;
  private cache: CacheManager;

  constructor(
    baseUrl: string = '',
    cacheOptions?: { ttl?: number; maxEntries?: number }
  ) {
    this.baseUrl =
      baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
    this.cache = new CacheManager(cacheOptions);

    // Clean expired entries every 5 minutes (only in browser context)
    if (typeof window !== 'undefined') {
      window.setInterval(() => this.cache.cleanExpired(), 5 * 60 * 1000);
    }
  }

  private getApiBase(): string {
    return `${this.baseUrl}/api/v1`;
  }

  private getFirstValue(value: unknown): string {
    if (!value) return '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value);
  }

  /**
   * Fetch with cache support for GET requests
   */
  private async cachedFetch<T>(url: string, options?: RequestInit): Promise<T> {
    const method = options?.method || 'GET';

    // Only cache GET requests
    if (method === 'GET') {
      const cached = this.cache.get<T>(url);
      if (cached !== null) {
        return cached;
      }
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as T;

    // Cache GET responses
    if (method === 'GET') {
      this.cache.set(url, data);
    }

    return data;
  }

  async getConfig(): Promise<Config> {
    return this.cachedFetch<Config>(`${this.getApiBase()}/config`);
  }

  async getSchema(schemaUrl: string): Promise<Schema> {
    // Handle relative URLs by prepending baseUrl
    const url = schemaUrl.startsWith('http')
      ? schemaUrl
      : `${this.baseUrl}${schemaUrl}`;
    return this.cachedFetch<Schema>(url);
  }

  async getUsers(search = ''): Promise<LdapUser[]> {
    const url = search
      ? `${this.getApiBase()}/ldap/users?match=${encodeURIComponent(search)}&attribute=uid`
      : `${this.getApiBase()}/ldap/users`;
    const data = await this.cachedFetch<LdapUser[] | Record<string, LdapUser>>(
      url
    );
    // Convert from object format {uid: entry} to array format
    return Array.isArray(data) ? data : Object.values(data);
  }

  async getUser(dn: string): Promise<LdapUser> {
    const url = `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`;
    return this.cachedFetch<LdapUser>(url);
  }

  async updateUser(dn: string, data: Partial<LdapUser>): Promise<LdapUser> {
    const res = await fetch(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(error || 'Failed to update user');
    }
    const result = await res.json();

    // Invalidate cache for this user and user lists
    this.cache.invalidate(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`
    );
    this.cache.invalidatePattern(`${this.getApiBase()}/ldap/users*`);

    return result;
  }

  async createUser(data: Partial<LdapUser>): Promise<LdapUser> {
    const res = await fetch(`${this.getApiBase()}/ldap/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.text();
      throw new Error(error || 'Failed to create user');
    }
    const result = await res.json();

    // Invalidate cache for user lists
    this.cache.invalidatePattern(`${this.getApiBase()}/ldap/users*`);

    return result;
  }

  async deleteUser(dn: string): Promise<void> {
    const res = await fetch(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`,
      {
        method: 'DELETE',
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(error || 'Failed to delete user');
    }

    // Invalidate cache for this user and user lists
    this.cache.invalidate(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`
    );
    this.cache.invalidatePattern(`${this.getApiBase()}/ldap/users*`);
  }

  async moveUser(
    dn: string,
    targetOrgDn: string
  ): Promise<{ success: boolean; newDn?: string }> {
    const res = await fetch(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}/move`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetOrgDn }),
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(error || 'Failed to move user');
    }
    const result = await res.json();

    // Invalidate cache for this user and user lists
    this.cache.invalidate(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`
    );
    this.cache.invalidatePattern(`${this.getApiBase()}/ldap/users*`);

    return result;
  }

  async getPointerOptions(branch: string): Promise<PointerOption[]> {
    try {
      // Load config to find the right endpoint by matching base
      const config = await this.getConfig();

      // Find resource that matches this branch by comparing base
      const resource = config.features?.flatResources?.find(r => {
        // Match if branch equals base or branch starts with base
        return branch === r.base || branch.startsWith(r.base);
      });

      if (resource && resource.endpoints?.list) {
        // Use the endpoint from config
        const url = `${this.baseUrl}${resource.endpoints.list}`;
        const data = await this.cachedFetch<
          LdapUser[] | Record<string, LdapUser>
        >(url);

        // Convert from object format {key: entry} to array
        const items = Array.isArray(data) ? data : Object.values(data);

        // Load schema to get displayName field
        let displayNameField = 'cn'; // Default fallback
        const identifierField = resource.mainAttribute;

        if (resource.schemaUrl) {
          try {
            const schema = await this.getSchema(resource.schemaUrl);
            // Find field with displayName role
            const displayField = Object.entries(schema.attributes).find(
              ([, attr]) => attr.role === 'displayName'
            );
            if (displayField) {
              displayNameField = displayField[0];
            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) {
            // Use defaults if schema fails
          }
        }

        return items.map((item: LdapUser) => {
          const displayName = this.getFirstValue(item[displayNameField]);
          const identifier = this.getFirstValue(item[identifierField]);
          return {
            dn: item.dn,
            label: displayName || identifier || item.dn,
          };
        });
      }

      // No matching resource found in config
      throw new Error(`No flatResource found in config for branch: ${branch}`);
    } catch (error) {
      console.error(
        'Failed to load pointer options for branch:',
        branch,
        error
      );
      return [];
    }
  }

  /**
   * Cache management methods
   */

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache for a specific URL pattern
   */
  invalidateCache(pattern: string): void {
    this.cache.invalidatePattern(pattern);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    ttl: number;
    keys: string[];
  } {
    return this.cache.getStats();
  }

  /**
   * Get cache instance (for advanced usage)
   */
  getCache(): CacheManager {
    return this.cache;
  }
}
