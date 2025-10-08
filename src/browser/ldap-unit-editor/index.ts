/**
 * LDAP Unit (Organization) Editor - Wrapper for organization management
 * @author Xavier Guimard
 */

import { LdapUserEditor } from '../ldap-user-editor/LdapUserEditor.js';
import type { EditorOptions as UserEditorOptions } from '../ldap-user-editor/types.js';

export interface UnitEditorOptions {
  containerId: string;
  apiBaseUrl?: string;
  onUnitSaved?: (unitDn: string) => void;
  onError?: (error: Error) => void;
}

/**
 * LDAP Unit Editor
 * Wraps LdapUserEditor with organization-specific configuration
 */
export class LdapUnitEditor {
  private userEditor: LdapUserEditor;
  private options: UnitEditorOptions;

  constructor(options: UnitEditorOptions) {
    this.options = options;

    // Map unit options to user editor options
    const userEditorOptions: UserEditorOptions = {
      containerId: options.containerId,
      apiBaseUrl: options.apiBaseUrl,
      onUserSaved: options.onUnitSaved,
      onError: options.onError,
    };

    this.userEditor = new LdapUserEditor(userEditorOptions);
  }

  async init(): Promise<void> {
    await this.userEditor.init();
  }

  getApi() {
    return this.userEditor.getApi();
  }

  getConfig() {
    return this.userEditor.getConfig();
  }

  getCurrentOrgDn(): string | null {
    return this.userEditor.getCurrentOrgDn();
  }

  getCurrentUserDn(): string | null {
    // In unit context, "user" means "organization unit"
    return this.userEditor.getCurrentUserDn();
  }

  async createUser(data: Record<string, unknown>) {
    // Reuse createUser method for units
    return this.userEditor.createUser(data);
  }

  async deleteUser(dn: string) {
    // Reuse deleteUser method for units
    return this.userEditor.deleteUser(dn);
  }
}
