/**
 * API Client for LDAP Unit operations
 */

import type { Config, LdapUnit } from '../types';

export class UnitApiClient {
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

  async getUnit(dn: string): Promise<LdapUnit> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
    );
    if (!response.ok) {
      throw new Error(`Failed to load unit: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Replace attributes of an entry.
   *
   * @param dn entry to change
   * @param replace attributes to replace; see `changedAttributes`
   */
  async updateUnit(
    dn: string,
    replace: Record<string, unknown>
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace }),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update unit: ${error}`);
    }
  }

  async createEntry(dn: string, data: Record<string, unknown>): Promise<void> {
    // Use the organizations API for creating units
    // Extract ou and parentDn from DN
    // DN format: ou=value,parent,dn,parts
    const match = dn.match(/^ou=([^,]+),(.+)$/);
    if (!match) {
      throw new Error(`Invalid DN format: ${dn}`);
    }
    const [, ou, parentDn] = match;

    const response = await fetch(`${this.baseUrl}/api/v1/ldap/organizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ou, parentDn, ...data }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create entry: ${error}`);
    }
  }

  async deleteEntry(dn: string): Promise<void> {
    // Use the organizations API for deleting units
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`,
      {
        method: 'DELETE',
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete entry: ${error}`);
    }
  }

  async moveUnit(
    dn: string,
    targetOrgDn: string
  ): Promise<{ success: boolean; newDn?: string }> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}/move`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetOrgDn }),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to move unit');
    }
    return response.json();
  }
}
