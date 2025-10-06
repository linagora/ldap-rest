/**
 * LDAP User Editor - API Client
 */

import type { Config, LdapUser, PointerOption, Schema } from '../types';

export class UserApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl || window.location.origin;
  }

  private getApiBase(): string {
    return `${this.baseUrl}/api/v1`;
  }

  private getFirstValue(value: any): string {
    if (!value) return '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value);
  }

  async getConfig(): Promise<Config> {
    const res = await fetch(`${this.getApiBase()}/config`);
    if (!res.ok) throw new Error('Failed to fetch config');
    return res.json();
  }

  async getSchema(schemaUrl: string): Promise<Schema> {
    const res = await fetch(schemaUrl);
    if (!res.ok) throw new Error('Failed to fetch schema');
    return res.json();
  }

  async getUsers(search = ''): Promise<LdapUser[]> {
    const url = search
      ? `${this.getApiBase()}/ldap/users?match=${encodeURIComponent(search)}&attribute=uid`
      : `${this.getApiBase()}/ldap/users`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch users');
    const data = await res.json();
    // Convert from object format {uid: entry} to array format
    return Array.isArray(data) ? data : Object.values(data);
  }

  async getUser(dn: string): Promise<LdapUser> {
    const res = await fetch(
      `${this.getApiBase()}/ldap/users/${encodeURIComponent(dn)}`
    );
    if (!res.ok) throw new Error('Failed to fetch user');
    return res.json();
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
    return res.json();
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
        const res = await fetch(`${this.baseUrl}${resource.endpoints.list}`);
        if (!res.ok) throw new Error(`Failed to fetch options from ${resource.endpoints.list}`);
        const data = await res.json();

        // Convert from object format {key: entry} to array
        const items = Array.isArray(data) ? data : Object.values(data);

        // Load schema to get displayName field
        let displayNameField = 'cn'; // Default fallback
        let identifierField = resource.mainAttribute;

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
          } catch (e) {
            // Use defaults if schema fails
          }
        }

        return items.map((item: any) => {
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
      console.error('Failed to load pointer options for branch:', branch, error);
      return [];
    }
  }
}
