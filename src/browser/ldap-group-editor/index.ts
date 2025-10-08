/**
 * LDAP Group Editor - Wrapper for groups management
 * @author Xavier Guimard
 */

import { LdapUserEditor } from '../ldap-user-editor/LdapUserEditor.js';
import type { EditorOptions as UserEditorOptions } from '../ldap-user-editor/types.js';

export interface GroupEditorOptions {
  containerId: string;
  apiBaseUrl?: string;
  onGroupSaved?: (groupDn: string) => void;
  onError?: (error: Error) => void;
}

/**
 * LDAP Group Editor
 * Wraps LdapUserEditor with group-specific configuration
 */
export class LdapGroupEditor {
  private userEditor: LdapUserEditor;
  private options: GroupEditorOptions;

  constructor(options: GroupEditorOptions) {
    this.options = options;

    // Map group options to user editor options
    const userEditorOptions: UserEditorOptions = {
      containerId: options.containerId,
      apiBaseUrl: options.apiBaseUrl,
      onUserSaved: options.onGroupSaved,
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
    // In group context, "user" means "group"
    return this.userEditor.getCurrentUserDn();
  }

  async createUser(data: Record<string, unknown>) {
    // Reuse createUser method for groups
    return this.userEditor.createUser(data);
  }

  async deleteUser(dn: string) {
    // Reuse deleteUser method for groups
    return this.userEditor.deleteUser(dn);
  }
}
