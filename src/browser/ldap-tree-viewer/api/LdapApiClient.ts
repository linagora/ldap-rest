/**
 * LDAP API Client for browser
 */

export class LdapApiClient {
  constructor(
    private baseUrl: string,
    private authToken?: string
  ) {}

  private async fetch<T>(endpoint: string): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  async getTopOrganization(): Promise<any> {
    return this.fetch('/api/v1/ldap/organizations/top');
  }

  async getOrganization(dn: string): Promise<any> {
    const encodedDn = encodeURIComponent(dn);
    return this.fetch(`/api/v1/ldap/organizations/${encodedDn}`);
  }

  async getOrganizationSubnodes(dn: string): Promise<any[]> {
    const encodedDn = encodeURIComponent(dn);
    return this.fetch(`/api/v1/ldap/organizations/${encodedDn}/subnodes`);
  }

  async searchOrganizationSubnodes(dn: string, query: string): Promise<any[]> {
    const encodedDn = encodeURIComponent(dn);
    const encodedQuery = encodeURIComponent(query);
    return this.fetch(`/api/v1/ldap/organizations/${encodedDn}/subnodes/search?q=${encodedQuery}`);
  }

  async getUsers(filter?: string): Promise<any> {
    const query = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    return this.fetch(`/api/v1/ldap/users${query}`);
  }

  async getGroups(filter?: string): Promise<any> {
    const query = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    return this.fetch(`/api/v1/ldap/groups${query}`);
  }
}
