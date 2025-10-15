/**
 * LDAP Resource Editor - Generic API Client
 */

import type {
  Config,
  LdapResource,
  PointerOption,
  Schema,
  ResourceType,
} from '../types';
import { CacheManager } from '../cache/CacheManager';

export class ResourceApiClient {
  private baseUrl: string;
  private cache: CacheManager;
  private resourceType: ResourceType;

  constructor(
    resourceType: ResourceType,
    baseUrl: string = '',
    cacheOptions?: { ttl?: number; maxEntries?: number }
  ) {
    this.resourceType = resourceType;
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

  private getResourceEndpoint(): string {
    return `${this.getApiBase()}/ldap/${this.resourceType}`;
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

  async getResources(search = ''): Promise<LdapResource[]> {
    const url = search
      ? `${this.getResourceEndpoint()}?match=${encodeURIComponent(search)}&attribute=${this.getMainAttribute()}`
      : this.getResourceEndpoint();
    const data = await this.cachedFetch<
      LdapResource[] | Record<string, LdapResource>
    >(url);
    // Convert from object format {key: entry} to array format
    return Array.isArray(data) ? data : Object.values(data);
  }

  async getResource(dn: string): Promise<LdapResource> {
    const url = `${this.getResourceEndpoint()}/${encodeURIComponent(dn)}`;
    return this.cachedFetch<LdapResource>(url);
  }

  async updateResource(
    dn: string,
    data: Partial<LdapResource>
  ): Promise<LdapResource> {
    const res = await fetch(
      `${this.getResourceEndpoint()}/${encodeURIComponent(dn)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(
        `Failed to update ${this.resourceType}: ${error || 'Unknown error'}`
      );
    }
    const result = await res.json();

    // Invalidate cache
    this.cache.invalidate(
      `${this.getResourceEndpoint()}/${encodeURIComponent(dn)}`
    );
    this.cache.invalidatePattern(`${this.getResourceEndpoint()}*`);

    return result;
  }

  async createResource(data: Partial<LdapResource>): Promise<LdapResource> {
    const res = await fetch(this.getResourceEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.text();
      throw new Error(
        `Failed to create ${this.resourceType}: ${error || 'Unknown error'}`
      );
    }
    const result = await res.json();

    // Invalidate cache
    this.cache.invalidatePattern(`${this.getResourceEndpoint()}*`);

    return result;
  }

  async deleteResource(dn: string): Promise<void> {
    const res = await fetch(
      `${this.getResourceEndpoint()}/${encodeURIComponent(dn)}`,
      {
        method: 'DELETE',
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(
        `Failed to delete ${this.resourceType}: ${error || 'Unknown error'}`
      );
    }

    // Invalidate cache
    this.cache.invalidate(
      `${this.getResourceEndpoint()}/${encodeURIComponent(dn)}`
    );
    this.cache.invalidatePattern(`${this.getResourceEndpoint()}*`);
  }

  /**
   * Create a generic entry (for organizations tree navigation)
   */
  async createEntry(
    dn: string,
    data: Partial<LdapResource>
  ): Promise<LdapResource> {
    const res = await fetch(
      `${this.getApiBase()}/ldap/entry/${encodeURIComponent(dn)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to create entry: ${error || 'Unknown error'}`);
    }
    const result = await res.json();

    // Invalidate cache
    this.cache.invalidatePattern(`${this.getResourceEndpoint()}*`);
    this.cache.invalidatePattern(`${this.getApiBase()}/ldap/organizations*`);

    return result;
  }

  /**
   * Delete a generic entry (for organizations)
   */
  async deleteEntry(dn: string): Promise<void> {
    const res = await fetch(
      `${this.getApiBase()}/ldap/entry/${encodeURIComponent(dn)}`,
      {
        method: 'DELETE',
      }
    );
    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to delete entry: ${error || 'Unknown error'}`);
    }

    // Invalidate cache
    this.cache.invalidatePattern(`${this.getResourceEndpoint()}*`);
    this.cache.invalidatePattern(`${this.getApiBase()}/ldap/organizations*`);
  }

  async getPointerOptions(branch: string): Promise<PointerOption[]> {
    try {
      const config = await this.getConfig();

      const resource = config.features?.ldapFlatGeneric?.flatResources?.find(
        r => {
          return branch === r.base || branch.startsWith(r.base);
        }
      );

      if (resource && resource.endpoints?.list) {
        const url = `${this.baseUrl}${resource.endpoints.list}`;
        const data = await this.cachedFetch<
          LdapResource[] | Record<string, LdapResource>
        >(url);

        const items = Array.isArray(data) ? data : Object.values(data);

        let displayNameField = 'cn';
        const identifierField = resource.mainAttribute;

        if (resource.schemaUrl) {
          try {
            const schema = await this.getSchema(resource.schemaUrl);
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

        return items.map((item: LdapResource) => {
          const displayName = this.getFirstValue(item[displayNameField]);
          const identifier = this.getFirstValue(item[identifierField]);
          return {
            dn: item.dn,
            label: displayName || identifier || item.dn,
          };
        });
      }

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
   * Get main attribute for this resource type
   */
  private getMainAttribute(): string {
    switch (this.resourceType) {
      case 'users':
        return 'uid';
      case 'groups':
        return 'cn';
      case 'organizations':
        return 'ou';
      default:
        return 'cn';
    }
  }

  /**
   * Cache management methods
   */
  clearCache(): void {
    this.cache.clear();
  }

  invalidateCache(pattern: string): void {
    this.cache.invalidatePattern(pattern);
  }

  getCacheStats(): {
    size: number;
    maxSize: number;
    ttl: number;
    keys: string[];
  } {
    return this.cache.getStats();
  }

  getCache(): CacheManager {
    return this.cache;
  }
}
