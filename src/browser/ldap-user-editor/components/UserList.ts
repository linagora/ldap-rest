/**
 * LDAP User Editor - User List Component
 * Shows users in a selected organization
 */

import type { LdapUser } from '../types';
import type { UserApiClient } from '../api/UserApiClient';

export class UserList {
  private container: HTMLElement;
  private api: UserApiClient;
  private users: LdapUser[] = [];
  private orgDn: string;
  private searchQuery = '';
  private onSelectUser: (dn: string) => void;

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
      listEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

      // Use organization subnodes API to get users in this org
      const baseUrl = this.api['baseUrl'] || window.location.origin;
      const res = await fetch(
        `${baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(this.orgDn)}/subnodes`
      );
      if (!res.ok) throw new Error('Failed to fetch organization users');

      const items = (await res.json()) as LdapUser[];
      // Filter only user entries
      this.users = items.filter(item => {
        const objectClass = item.objectClass as string[];
        return objectClass?.includes('twakeAccount') ||
               objectClass?.includes('inetOrgPerson') ||
               item.dn.includes('uid=');
      });

      this.renderUserList();
    } catch (error) {
      console.error('Failed to load users:', error);
      listEl.innerHTML =
        '<div class="empty-state"><span class="material-icons">error</span><p>Failed to load users</p></div>';
    }
  }

  private getFirstValue(value: any): string {
    if (!value) return '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value);
  }

  private renderUserList(): void {
    const listEl = this.container.querySelector('#user-list-items');
    if (!listEl) return;

    // Filter users by search query
    const filteredUsers = this.searchQuery
      ? this.users.filter(user => {
          const cn = this.getFirstValue(user.cn).toLowerCase();
          const uid = this.getFirstValue(user.uid).toLowerCase();
          const mail = this.getFirstValue(user.mail).toLowerCase();
          const query = this.searchQuery.toLowerCase();
          return cn.includes(query) || uid.includes(query) || mail.includes(query);
        })
      : this.users;

    if (filteredUsers.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state"><span class="material-icons">person_search</span><p>No users found</p></div>';
      return;
    }

    listEl.innerHTML = filteredUsers
      .map(user => {
        const cn = this.getFirstValue(user.cn);
        const uid = this.getFirstValue(user.uid);
        const mail = this.getFirstValue(user.mail);
        const displayName = cn || uid || 'Unknown';

        return `
      <div
        class="tree-node"
        data-dn="${user.dn}"
      >
        <span class="material-icons">person</span>
        <div class="tree-node-content">
          <div class="tree-node-name">
            ${displayName}
          </div>
          ${mail ? `<div class="tree-node-email">${mail}</div>` : ''}
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
