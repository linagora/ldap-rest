/**
 * LDAP Unit Editor - Main component for editing organizational units
 */

import { UnitTree } from './components/UnitTree.js';
import { UnitPropertyEditor } from './components/UnitPropertyEditor.js';
import { UnitApiClient } from './api/UnitApiClient.js';
import type { UnitEditorOptions, Config } from './types';

export class LdapUnitEditor {
  private container: HTMLElement | null = null;
  private options: UnitEditorOptions;
  private api: UnitApiClient;
  private unitTree: UnitTree | null = null;
  private unitEditor: UnitPropertyEditor | null = null;
  private currentUnitDn: string | null = null;
  private config: Config | null = null;

  constructor(options: UnitEditorOptions) {
    this.options = options;
    this.api = new UnitApiClient(options.apiBaseUrl || '');
  }

  async init(): Promise<void> {
    const container = document.getElementById(this.options.containerId);
    if (!container) {
      throw new Error(
        `Container element with id '${this.options.containerId}' not found`
      );
    }
    this.container = container;

    // Load config first
    this.config = await this.api.getConfig();

    this.render();
    await this.initializeComponents();
  }

  private render(): void {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="ldap-unit-editor" style="display: flex; gap: 24px; height: 100%;">
        <div id="unit-tree-container" style="flex: 0 0 300px; overflow-y: auto; border-right: 1px solid #e0e0e0; padding-right: 24px;"></div>
        <div id="unit-editor-container" style="flex: 1; overflow-y: auto;">
          <div class="empty-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #999;">
            <span class="material-icons" style="font-size: 64px; margin-bottom: 16px;">business</span>
            <p style="font-size: 16px; margin: 0;">Select an organizational unit to edit</p>
          </div>
        </div>
      </div>
    `;
  }

  private async initializeComponents(): Promise<void> {
    const treeContainer = document.getElementById('unit-tree-container');
    if (!treeContainer) return;

    this.unitTree = new UnitTree(
      treeContainer,
      this.options.apiBaseUrl || '',
      unitDn => this.onUnitSelected(unitDn)
    );

    await this.unitTree.init();
  }

  private async onUnitSelected(unitDn: string): Promise<void> {
    this.currentUnitDn = unitDn;

    const editorContainer = document.getElementById('unit-editor-container');
    if (!editorContainer) return;

    try {
      this.unitEditor = new UnitPropertyEditor(
        editorContainer,
        this.api,
        unitDn
      );
      await this.unitEditor.init();

      this.unitEditor.onSave(() => {
        if (this.options.onUnitSaved) {
          this.options.onUnitSaved(unitDn);
        }
      });
    } catch (error) {
      console.error('Failed to load unit editor:', error);
      editorContainer.innerHTML = `
        <div class="error-state" style="padding: 24px; color: #f44336;">
          <h3>Error loading unit</h3>
          <p>${(error as Error).message}</p>
        </div>
      `;
      if (this.options.onError) {
        this.options.onError(error as Error);
      }
    }
  }

  getCurrentUnitDn(): string | null {
    return this.currentUnitDn;
  }

  async refresh(): Promise<void> {
    if (this.unitTree) {
      await this.unitTree.init();
    }
    if (this.currentUnitDn && this.unitEditor) {
      const editorContainer = document.getElementById('unit-editor-container');
      if (editorContainer) {
        this.unitEditor = new UnitPropertyEditor(
          editorContainer,
          this.api,
          this.currentUnitDn
        );
        await this.unitEditor.init();
      }
    }
  }

  // Public API for compatibility with tests
  getApi(): UnitApiClient {
    return this.api;
  }

  getConfig(): Config | null {
    return this.config;
  }

  getCurrentOrgDn(): string | null {
    // For units, the current org is the current unit
    return this.currentUnitDn;
  }

  getCurrentUserDn(): string | null {
    // For compatibility - in unit context, "user" means "unit"
    return this.currentUnitDn;
  }

  async createUser(data: Record<string, unknown>): Promise<void> {
    // For compatibility - actually creates an organizational unit
    return this.api.createEntry(data.dn as string, data);
  }

  async deleteUser(dn: string): Promise<void> {
    // For compatibility - actually deletes an organizational unit
    return this.api.deleteEntry(dn);
  }
}
