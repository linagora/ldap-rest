/**
 * LDAP User Editor - Main class
 * @author Xavier Guimard
 */

import type { EditorOptions, Config, LdapUser } from './types';
import { UserApiClient } from './api/UserApiClient';
import { UserTree } from './components/UserTree';
import { UserEditor } from './components/UserEditor';
import { UserList } from './components/UserList';

export class LdapUserEditor {
  private options: EditorOptions;
  private api: UserApiClient;
  private container: HTMLElement | null = null;
  private userTree: UserTree | null = null;
  private userEditor: UserEditor | null = null;
  private userList: UserList | null = null;
  private currentUserDn: string | null = null;
  private currentOrgDn: string | null = null;
  private config: Config | null = null;

  constructor(options: EditorOptions) {
    this.options = {
      apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      ...options,
    };

    this.api = new UserApiClient(this.options.apiBaseUrl);
  }

  async init(): Promise<void> {
    this.container = document.getElementById(this.options.containerId);
    if (!this.container) {
      throw new Error(`Container #${this.options.containerId} not found`);
    }

    // Load config first
    this.config = await this.api.getConfig();

    this.render();
    await this.initComponents();
  }

  private render(): void {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="ldap-user-editor">
        <div class="editor-layout">
          <div id="user-tree-container" class="demo-panel"></div>
          <div id="user-editor-container" class="demo-panel">
            <div class="empty-state">
              <span class="material-icons">person_search</span>
              <p>Select a user from the list to edit</p>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private async initComponents(): Promise<void> {
    const treeContainer = document.getElementById('user-tree-container');
    if (!treeContainer) return;

    this.userTree = new UserTree(
      treeContainer,
      this.options.apiBaseUrl || window.location.origin,
      orgDn => this.onOrganizationSelected(orgDn)
    );

    try {
      await this.userTree.init();
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private async onOrganizationSelected(dn: string): Promise<void> {
    const editorContainer = document.getElementById('user-editor-container');
    if (!editorContainer) return;

    this.currentOrgDn = dn;
    this.currentUserDn = null;

    try {
      // Show user list for this organization
      this.userList = new UserList(editorContainer, this.api, dn, userDn =>
        this.onUserSelected(userDn)
      );
      await this.userList.init();
    } catch (error) {
      this.handleError(error as Error);
      editorContainer.innerHTML = `
        <div class="empty-state">
          <span class="material-icons">error</span>
          <p>Failed to load users for this organization</p>
        </div>
      `;
    }
  }

  private async onUserSelected(dn: string): Promise<void> {
    this.currentUserDn = dn;

    const editorContainer = document.getElementById('user-editor-container');
    if (!editorContainer) return;

    this.userEditor = new UserEditor(
      editorContainer,
      this.api,
      dn,
      () => {
        if (this.options.onUserSaved) {
          this.options.onUserSaved(dn);
        }
        // Refresh the user list if we have one
        if (this.currentOrgDn && this.userList) {
          this.userList.refresh();
        }
      },
      () => {
        // On user deleted
        this.deleteUser(dn);
      }
    );

    try {
      await this.userEditor.init();
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private handleError(error: Error): void {
    console.error('LDAP User Editor error:', error);
    if (this.options.onError) {
      this.options.onError(error);
    }
  }

  async refresh(): Promise<void> {
    await this.userTree?.refresh();
    if (this.currentUserDn) {
      await this.userEditor?.refresh();
    }
  }

  destroy(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.userTree = null;
    this.userEditor = null;
    this.currentUserDn = null;
  }

  async createUser(userData: Partial<LdapUser>): Promise<LdapUser> {
    try {
      const result = await this.api.createUser(userData);
      // Refresh the user list if we have one
      if (this.userList) {
        await this.userList.refresh();
      }
      return result;
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }

  async deleteUser(dn: string): Promise<void> {
    try {
      await this.api.deleteUser(dn);
      // Clear current selection if we deleted the selected user
      if (this.currentUserDn === dn) {
        this.currentUserDn = null;
        const editorContainer = document.getElementById(
          'user-editor-container'
        );
        if (editorContainer) {
          editorContainer.innerHTML = `
            <div class="empty-state">
              <span class="material-icons">person_search</span>
              <p>Select a user from the list to edit</p>
            </div>
          `;
        }
      }
      // Refresh the user list
      if (this.userList) {
        await this.userList.refresh();
      }
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }

  getConfig(): Config | null {
    return this.config;
  }

  getApi(): UserApiClient {
    return this.api;
  }

  getCurrentOrgDn(): string | null {
    return this.currentOrgDn;
  }

  getCurrentUserDn(): string | null {
    return this.currentUserDn;
  }
}
