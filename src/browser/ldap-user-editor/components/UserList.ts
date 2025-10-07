/**
 * LDAP User Editor - User List Component
 * Shows users in a selected organization
 */

import type { LdapUser, Schema, Config } from '../types';
import type { UserApiClient } from '../api/UserApiClient';

export class UserList {
  private container: HTMLElement;
  private api: UserApiClient;
  private users: LdapUser[] = [];
  private orgDn: string;
  private searchQuery = '';
  private onSelectUser: (dn: string) => void;
  private schema: Schema | null = null;
  private config: Config | null = null;

  constructor(
    container: HTMLElement,
    api: UserApiClient,
    orgDn: string,
    onSelectUser: (dn: string) => void
  ) {
    this.container = container;
    this.api = api;
    this.orgDn = orgDn;
    this.onSelectUser = onSelectUser;
  }

  async init(): Promise<void> {
    // Load config and schema first
    this.config = await this.api.getConfig();
    const usersResource = this.config.features?.flatResources?.find(
      r => r.pluralName === 'users' || r.name === 'users'
    );
    if (usersResource?.schemaUrl) {
      this.schema = await this.api.getSchema(usersResource.schemaUrl);
    }

    this.render();
    await this.loadUsers();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="user-list-container">
        <div class="user-list-header">
          <h2>
            <span class="material-icons">people</span>
            Users
          </h2>
          <div class="search-box">
            <span class="material-icons">search</span>
            <input
              type="text"
              placeholder="Search users in this organization..."
              id="user-list-search-input"
            />
          </div>
        </div>
        <div class="user-list" id="user-list-items">
          <div class="loading">
            <div class="spinner"></div>
          </div>
        </div>
      </div>
    `;

    const searchInput = this.container.querySelector(
      '#user-list-search-input'
    ) as HTMLInputElement;
    searchInput?.addEventListener('input', e => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.renderUserList();
    });
  }

  private async loadUsers(): Promise<void> {
    const listEl = this.container.querySelector('#user-list-items');
    if (!listEl) return;

    try {
      listEl.innerHTML =
        '<div class="loading"><div class="spinner"></div></div>';

      // Use organization subnodes API to get users in this org
      // Filter by the first objectClass from schema to get only users (not groups/OUs)
      const baseUrl = this.api['baseUrl'] || window.location.origin;
      const objectClass =
        this.schema?.entity?.objectClass?.[1] || 'twakeAccount'; // Use second objectClass (not 'top')
      const res = await fetch(
        `${baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(this.orgDn)}/subnodes?objectClass=${encodeURIComponent(objectClass)}`
      );
      if (!res.ok) throw new Error('Failed to fetch organization users');

      const items = (await res.json()) as LdapUser[];

      // Filter only user entries using schema objectClass
      // An item is a user if it has ALL the expected objectClasses
      const expectedObjectClasses = this.schema?.entity?.objectClass || [];
      const mainAttribute = this.schema?.entity?.mainAttribute || '';

      this.users = items.filter(item => {
        const objectClass = Array.isArray(item.objectClass)
          ? item.objectClass
          : [item.objectClass];

        // Must have the mainAttribute field (uid, sAMAccountName, etc.)
        if (!item[mainAttribute]) return false;

        // Check if item has ALL the expected objectClasses
        return expectedObjectClasses.every(expected =>
          objectClass.includes(expected)
        );
      });

      this.renderUserList();
    } catch (error) {
      console.error('Failed to load users:', error);
      listEl.innerHTML =
        '<div class="empty-state"><span class="material-icons">error</span><p>Failed to load users</p></div>';
    }
  }

  private getFirstValue(value: unknown): string {
    if (!value) return '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value);
  }

  private getFieldNameByRole(role: string): string | null {
    if (!this.schema) return null;

    const field = Object.entries(this.schema.attributes).find(
      ([, attr]) => attr.role === role
    );

    return field ? field[0] : null;
  }

  private getFieldValueByRole(user: LdapUser, role: string): string {
    const fieldName = this.getFieldNameByRole(role);
    if (!fieldName) return '';
    return this.getFirstValue(user[fieldName]);
  }

  private renderUserList(): void {
    const listEl = this.container.querySelector('#user-list-items');
    if (!listEl) return;

    // Get field names from schema roles
    const displayNameField = this.getFieldNameByRole('displayName');
    const identifierField = this.schema?.entity?.mainAttribute || '';
    const emailField = this.getFieldNameByRole('primaryEmail');

    // Filter users by search query
    const filteredUsers = this.searchQuery
      ? this.users.filter(user => {
          const displayName = displayNameField
            ? this.getFirstValue(user[displayNameField]).toLowerCase()
            : '';
          const identifier = this.getFirstValue(
            user[identifierField]
          ).toLowerCase();
          const email = emailField
            ? this.getFirstValue(user[emailField]).toLowerCase()
            : '';
          const query = this.searchQuery.toLowerCase();
          return (
            displayName.includes(query) ||
            identifier.includes(query) ||
            email.includes(query)
          );
        })
      : this.users;

    if (filteredUsers.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state"><span class="material-icons">person_search</span><p>No users found</p></div>';
      return;
    }

    listEl.innerHTML = filteredUsers
      .map(user => {
        const displayName = displayNameField
          ? this.getFirstValue(user[displayNameField])
          : '';
        const identifier = this.getFirstValue(user[identifierField]);
        const email = emailField ? this.getFirstValue(user[emailField]) : '';
        const name = displayName || identifier || 'Unknown';

        return `
      <div
        class="tree-node"
        data-dn="${user.dn}"
      >
        <span class="material-icons">person</span>
        <div class="tree-node-content">
          <div class="tree-node-name">
            ${name}
          </div>
          ${email ? `<div class="tree-node-email">${email}</div>` : ''}
        </div>
      </div>
    `;
      })
      .join('');

    // Add click handlers
    listEl.querySelectorAll('.tree-node').forEach(node => {
      node.addEventListener('click', () => {
        const dn = node.getAttribute('data-dn');
        if (dn) {
          this.onSelectUser(dn);
        }
      });
    });
  }

  async refresh(): Promise<void> {
    await this.loadUsers();
  }
}
