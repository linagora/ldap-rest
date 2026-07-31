/**
 * Client of the low-level LDAP API (`core/ldap/raw` plugin).
 * @module browser/ldap-browser/api/RawApiClient
 */

import type {
  LdapSchema,
  RawChildren,
  RawEntry,
  RawSearchResult,
} from '../types';

export class RawApiClient {
  private baseUrl: string;
  private authToken?: string;

  constructor(baseUrl = '', authToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = authToken;
  }

  /**
   * Issue a GET on the raw API and decode its JSON answer.
   *
   * @param path path below `/api/v1/ldap/raw`
   * @returns decoded body
   * @throws Error carrying the server message when the status is not 2xx
   */
  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    const response = await fetch(`${this.baseUrl}/api/v1/ldap/raw${path}`, {
      headers,
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // keep the status text
      }
      throw new Error(`${response.status}: ${message}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Subtrees the server exposes, used as roots of the tree.
   *
   * @returns list of base DNs
   */
  async getBases(): Promise<string[]> {
    const data = await this.get<{ bases: string[] }>('/bases');
    return data.bases;
  }

  /**
   * Server capabilities.
   *
   * @returns root DSE
   */
  getRootDse(): Promise<RawEntry> {
    return this.get<RawEntry>('/rootdse');
  }

  /**
   * Directory schema.
   *
   * @returns object classes, attribute types, syntaxes and matching rules
   */
  getSchema(): Promise<LdapSchema> {
    return this.get<LdapSchema>('/schema');
  }

  /**
   * Read one entry.
   *
   * @param dn DN of the entry
   * @returns the entry with all its attributes
   */
  getEntry(dn: string): Promise<RawEntry> {
    return this.get<RawEntry>(`/entry/${encodeURIComponent(dn)}`);
  }

  /**
   * List the direct children of an entry.
   *
   * @param dn DN of the parent
   * @param withChildrenFlag ask the server which children have children
   * @returns children sorted by RDN, with the truncation flag
   */
  getChildren(dn: string, withChildrenFlag = true): Promise<RawChildren> {
    return this.get<RawChildren>(
      `/children/${encodeURIComponent(dn)}${withChildrenFlag ? '?children=1' : ''}`
    );
  }

  /**
   * Run a search.
   *
   * @param params search base, scope, filter and limit
   * @returns matching entries
   */
  search(params: {
    base: string;
    scope?: 'base' | 'one' | 'sub';
    filter?: string;
    attributes?: string[];
    limit?: number;
  }): Promise<RawSearchResult> {
    const query = new URLSearchParams({ base: params.base });
    if (params.scope) query.set('scope', params.scope);
    if (params.filter) query.set('filter', params.filter);
    if (params.attributes?.length)
      query.set('attributes', params.attributes.join(','));
    if (params.limit) query.set('limit', String(params.limit));
    return this.get<RawSearchResult>(`/search?${query.toString()}`);
  }
}
