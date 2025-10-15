/**
 * API Client for LDAP Group operations
 */

import type { Config, LdapGroup } from '../types';

export class GroupApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async getConfig(): Promise<Config> {
    const response = await fetch(`${this.baseUrl}/api/v1/config`);
    if (!response.ok) {
      throw new Error(`Failed to load config: ${response.statusText}`);
    }
    return response.json();
  }

  async getOrganizations(): Promise<{ dn: string }> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/top`
    );
    if (!response.ok) {
      throw new Error(`Failed to load organizations: ${response.statusText}`);
    }
    return response.json();
  }

  async getGroups(orgDn: string): Promise<LdapGroup[]> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}/subnodes?objectClass=groupOfNames`
    );
    if (!response.ok) {
      throw new Error(`Failed to load groups: ${response.statusText}`);
    }
    const subnodes = await response.json();
    // Filter to keep only groups
    return subnodes.filter((node: any) => {
      const classes = Array.isArray(node.objectClass)
        ? node.objectClass
        : [node.objectClass];
      return classes.includes('groupOfNames') || classes.includes('group');
    });
  }

  async getGroup(dn: string): Promise<LdapGroup> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(dn)}`
    );
    if (!response.ok) {
      throw new Error(`Failed to load group: ${response.statusText}`);
    }
    return response.json();
  }

  async updateGroup(dn: string, data: Partial<LdapGroup>): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(dn)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update group: ${error}`);
    }
  }

  async createEntry(dn: string, data: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/v1/ldap/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dn, ...data }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create entry: ${error}`);
    }
  }

  async deleteEntry(dn: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/entries/${encodeURIComponent(dn)}`,
      {
        method: 'DELETE',
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete entry: ${error}`);
    }
  }

  async moveGroup(cn: string, targetOrgDn: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(cn)}/move`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetOrgDn }),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to move group: ${error}`);
    }
  }

  async getPointerOptions(
    branch: string
  ): Promise<Array<{ dn: string; label: string }>> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/search?base=${encodeURIComponent(branch)}&scope=one`
    );
    if (!response.ok) {
      throw new Error(`Failed to load pointer options: ${response.statusText}`);
    }
    const entries = await response.json();
    return entries.map((entry: any) => ({
      dn: entry.dn,
      label: entry.cn?.[0] || entry.ou?.[0] || entry.dn,
    }));
  }
}
