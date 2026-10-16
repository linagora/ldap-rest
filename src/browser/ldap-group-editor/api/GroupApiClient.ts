/**
 * API Client for LDAP Group operations
 */

import type { Config, Entry, LdapGroup } from '../types';

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
    return subnodes.filter((node: Entry) => {
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

  /**
   * Replace attributes of an entry.
   *
   * @param dn entry to change
   * @param replace attributes to replace; see `changedAttributes`
   */
  async updateGroup(
    dn: string,
    replace: Record<string, unknown>
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(dn)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace }),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update group: ${error}`);
    }
  }

  async createEntry(dn: string, data: Record<string, unknown>): Promise<void> {
    // Use the groups API for creating groups
    const response = await fetch(`${this.baseUrl}/api/v1/ldap/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create entry: ${error}`);
    }
  }

  async deleteEntry(dn: string): Promise<void> {
    // Use the groups API for deleting groups
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(dn)}`,
      {
        method: 'DELETE',
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete entry: ${error}`);
    }
  }

  /** Add members through the route that checks them */
  async addMembers(dn: string, member: string[]): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(dn)}/members`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member }),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add members: ${error}`);
    }
  }

  async removeMember(dn: string, member: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(dn)}/members/${encodeURIComponent(member)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to remove member: ${error}`);
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

  async renameGroup(cn: string, newCn: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/groups/${encodeURIComponent(cn)}/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newCn }),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to rename group: ${error}`);
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
    return entries.map((entry: Entry) => ({
      dn: entry.dn,
      label:
        (entry.cn as string[] | undefined)?.[0] ||
        (entry.ou as string[] | undefined)?.[0] ||
        entry.dn,
    }));
  }
}
