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

  async updateUnit(dn: string, data: Partial<LdapUnit>): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to update unit: ${error}`);
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
