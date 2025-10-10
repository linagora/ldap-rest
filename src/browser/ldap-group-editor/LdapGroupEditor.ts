/**
 * LDAP Group Editor - Main class for editing group properties
 * @author Xavier Guimard
 */

import type { GroupEditorOptions, Config } from './types';
import { GroupApiClient } from './api/GroupApiClient';
import { GroupTree } from './components/GroupTree';
import { GroupPropertyEditor } from './components/GroupPropertyEditor';

export class LdapGroupEditor {
  private options: GroupEditorOptions;
  private api: GroupApiClient;
  private container: HTMLElement | null = null;
  private groupTree: GroupTree | null = null;
  private groupEditor: GroupPropertyEditor | null = null;
  private currentGroupDn: string | null = null;
  private currentOrgDn: string | null = null;
  private config: Config | null = null;

  constructor(options: GroupEditorOptions) {
    this.options = {
      apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      ...options,
    };

    this.api = new GroupApiClient(this.options.apiBaseUrl || '');
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
      <div class="ldap-group-editor">
        <div class="editor-layout">
          <div id="group-tree-container" class="demo-panel"></div>
          <div id="group-editor-container" class="demo-panel">
            <div class="empty-state">
              <span class="material-icons">group</span>
              <p>Select a group from the tree to edit its properties</p>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private async initComponents(): Promise<void> {
    const treeContainer = document.getElementById('group-tree-container');
    if (!treeContainer) return;

    this.groupTree = new GroupTree(
      treeContainer,
      this.options.apiBaseUrl || window.location.origin,
      orgDn => this.onOrgSelected(orgDn)
    );

    try {
      await this.groupTree.init();
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  private async onOrgSelected(orgDn: string): Promise<void> {
    const editorContainer = document.getElementById('group-editor-container');
    if (!editorContainer) return;

    this.currentOrgDn = orgDn;

    try {
      // Load groups for this organization
      const groups = await this.api.getGroups(orgDn);

      if (groups.length === 0) {
        editorContainer.innerHTML = `
          <div class="empty-state">
            <span class="material-icons">group</span>
            <p>No groups in this organization</p>
          </div>
        `;
        return;
      }

      // Show list of groups
      editorContainer.innerHTML = `
        <div style="padding: 20px;">
          <h3 style="margin: 0 0 16px 0;">Groups</h3>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${groups
              .map(
                group => `
              <div class="group-item" data-dn="${this.escapeHtml(group.dn)}" style="padding: 12px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span class="material-icons">group</span>
                <span>${this.escapeHtml(group.cn || group.dn)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;

      // Attach click handlers
      editorContainer.querySelectorAll('.group-item').forEach(item => {
        item.addEventListener('click', () => {
          const groupDn = (item as HTMLElement).dataset.dn!;
          this.onGroupSelected(groupDn);
        });
      });
    } catch (error) {
      this.handleError(error as Error);
      editorContainer.innerHTML = `
        <div class="empty-state">
          <span class="material-icons">error</span>
          <p>Failed to load groups</p>
        </div>
      `;
    }
  }

  private async onGroupSelected(groupDn: string): Promise<void> {
    const editorContainer = document.getElementById('group-editor-container');
    if (!editorContainer) return;

    this.currentGroupDn = groupDn;

    try {
      // Show group property editor
      this.groupEditor = new GroupPropertyEditor(
        editorContainer,
        this.api,
        groupDn
      );
      await this.groupEditor.init();

      // Notify parent
      if (this.options.onGroupSaved) {
        this.groupEditor.onSave(() => {
          this.options.onGroupSaved?.(groupDn);
        });
      }
    } catch (error) {
      this.handleError(error as Error);
      editorContainer.innerHTML = `
        <div class="empty-state">
          <span class="material-icons">error</span>
          <p>Failed to load group properties</p>
        </div>
      `;
    }
  }

  private escapeHtml(text: string | null | undefined): string {
    if (text == null) return '';
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };
    return String(text).replace(/[&<>"'/]/g, m => map[m]);
  }

  private handleError(error: Error): void {
    console.error('LdapGroupEditor error:', error);
    if (this.options.onError) {
      this.options.onError(error);
    }
  }

  // Public API
  getApi(): GroupApiClient {
    return this.api;
  }

  getConfig(): Config | null {
    return this.config;
  }

  getCurrentOrgDn(): string | null {
    return this.currentOrgDn;
  }

  getCurrentUserDn(): string | null {
    // For compatibility with HTML that calls getCurrentUserDn
    return this.currentGroupDn;
  }

  async createUser(data: Record<string, unknown>): Promise<void> {
    // For compatibility - actually creates a group
    return this.api.createEntry(data.dn as string, data);
  }

  async deleteUser(dn: string): Promise<void> {
    // For compatibility - actually deletes a group
    return this.api.deleteEntry(dn);
  }
}
