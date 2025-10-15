/**
 * Group Property Editor Component - Edits properties of a selected group
 */

import type { GroupApiClient } from '../api/GroupApiClient';
import type { LdapGroup, SchemaDefinition } from '../types';
import { MoveGroupModal } from './MoveGroupModal';

export class GroupPropertyEditor {
  private container: HTMLElement;
  private api: GroupApiClient;
  private groupDn: string;
  private group: LdapGroup | null = null;
  private schema: SchemaDefinition | null = null;
  private saveCallback: (() => void) | null = null;

  constructor(container: HTMLElement, api: GroupApiClient, groupDn: string) {
    this.container = container;
    this.api = api;
    this.groupDn = groupDn;
  }

  async init(): Promise<void> {
    try {
      await this.loadGroup();
      await this.loadSchema();
      this.render();
      this.attachEventListeners();
    } catch (error) {
      console.error('Failed to init GroupPropertyEditor:', error);
      throw error;
    }
  }

  private async loadGroup(): Promise<void> {
    console.warn('[GroupPropertyEditor] Loading group:', this.groupDn);
    this.group = await this.api.getGroup(this.groupDn);
    console.warn('[GroupPropertyEditor] Group loaded:', this.group);
  }

  private async loadSchema(): Promise<void> {
    console.warn('[GroupPropertyEditor] Loading schema...');
    const config = await this.api.getConfig();
    console.warn('[GroupPropertyEditor] Config loaded:', config);

    // First check in features.ldapGroups (from ldapGroups plugin)
    const groupsConfig = (config.features as any)?.ldapGroups;
    console.warn('[GroupPropertyEditor] Groups config:', groupsConfig);

    if (groupsConfig?.schemaUrl) {
      const response = await fetch(groupsConfig.schemaUrl);
      this.schema = await response.json();
      console.warn(
        '[GroupPropertyEditor] Schema loaded from URL:',
        this.schema
      );
    } else if (groupsConfig?.schema) {
      this.schema = groupsConfig.schema;
      console.warn(
        '[GroupPropertyEditor] Schema loaded from config:',
        this.schema
      );
    } else {
      // Fallback: check in flatResources
      const groupsResource =
        config.features?.ldapFlatGeneric?.flatResources?.find(
          r => r.pluralName === 'groups' || r.name === 'groups'
        );
      console.warn(
        '[GroupPropertyEditor] Groups resource (flatResources):',
        groupsResource
      );

      if (groupsResource?.schemaUrl) {
        const response = await fetch(groupsResource.schemaUrl);
        this.schema = await response.json();
        console.warn(
          '[GroupPropertyEditor] Schema loaded from URL (flatResources):',
          this.schema
        );
      } else if (groupsResource?.schema) {
        this.schema = groupsResource.schema;
        console.warn(
          '[GroupPropertyEditor] Schema loaded from config (flatResources):',
          this.schema
        );
      } else {
        // No schema configured - create a default schema from the group's attributes
        console.warn(
          '[GroupPropertyEditor] No schema configured, creating default schema from group attributes'
        );
        this.schema = this.createDefaultSchema();
        console.warn(
          '[GroupPropertyEditor] Default schema created:',
          this.schema
        );
      }
    }
  }

  private createDefaultSchema(): SchemaDefinition {
    if (!this.group) {
      return { entity: { objectClass: [] }, attributes: {} };
    }

    const attributes: Record<string, any> = {};

    // Create schema attributes from the group's actual attributes
    for (const [key, value] of Object.entries(this.group)) {
      if (key === 'dn' || key === '*' || key === 'objectClass') continue;

      const isArray = Array.isArray(value);
      attributes[key] = {
        type: isArray ? 'array' : 'string',
        required: false,
        fixed: key === 'dn',
      };
    }

    return {
      entity: {
        objectClass: Array.isArray(this.group.objectClass)
          ? this.group.objectClass
          : [this.group.objectClass],
      },
      attributes,
    };
  }

  onSave(callback: () => void): void {
    this.saveCallback = callback;
  }

  private render(): void {
    if (!this.group) return;

    this.container.innerHTML = `
      <div class="group-property-editor">
        <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
          <span class="material-icons">group</span>
          Edit Group
        </h3>
        <form id="group-edit-form">
          ${this.renderFields()}
          <div class="form-actions" style="margin-top: 24px; padding-top: 24px; border-top: 1px solid #e0e0e0; display: flex; gap: 12px; justify-content: space-between;">
            <button type="button" id="move-group-btn" class="btn btn-secondary" style="background: #757575; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
              <span class="material-icons" style="font-size: 18px;">drive_file_move</span>
              Move
            </button>
            <div style="display: flex; gap: 12px;">
              <button type="button" id="delete-group-btn" class="btn btn-danger" style="background: #d32f2f; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span class="material-icons" style="font-size: 18px;">delete</span>
                Delete Group
              </button>
              <button type="submit" class="btn btn-primary" style="background: var(--primary-color, #6200ee); color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span class="material-icons" style="font-size: 18px;">save</span>
                Save Changes
              </button>
            </div>
          </div>
        </form>
      </div>
    `;
  }

  private renderFields(): string {
    if (!this.group || !this.schema) {
      return '<div>Loading...</div>';
    }

    let html = '';

    // Group fields by category
    const basicFields: [string, any][] = [];
    const memberFields: [string, any][] = [];
    const mailFields: [string, any][] = [];

    for (const [fieldName, attribute] of Object.entries(
      this.schema.attributes
    )) {
      if (attribute.fixed || fieldName === 'objectClass') continue;

      if (fieldName === 'member' || fieldName === 'owner') {
        memberFields.push([fieldName, attribute]);
      } else if (fieldName.includes('mail') || fieldName.includes('Mail')) {
        mailFields.push([fieldName, attribute]);
      } else {
        basicFields.push([fieldName, attribute]);
      }
    }

    // Basic Information
    if (basicFields.length > 0) {
      html +=
        '<div class="field-group" style="margin-bottom: 20px; padding: 16px; background: #f9f9f9; border-radius: 4px;">';
      html +=
        '<div class="field-group-title" style="font-weight: 500; color: var(--primary-color, #6200ee); margin-bottom: 12px; font-size: 14px; text-transform: uppercase;">Basic Information</div>';
      for (const [fieldName, attribute] of basicFields) {
        html += this.renderField(fieldName, attribute);
      }
      html += '</div>';
    }

    // Email/Mailbox Settings
    if (mailFields.length > 0) {
      html +=
        '<div class="field-group" style="margin-bottom: 20px; padding: 16px; background: #f9f9f9; border-radius: 4px;">';
      html +=
        '<div class="field-group-title" style="font-weight: 500; color: var(--primary-color, #6200ee); margin-bottom: 12px; font-size: 14px; text-transform: uppercase;">Email/Mailbox Settings</div>';
      for (const [fieldName, attribute] of mailFields) {
        html += this.renderField(fieldName, attribute);
      }
      html += '</div>';
    }

    // Members & Owners
    if (memberFields.length > 0) {
      html +=
        '<div class="field-group" style="margin-bottom: 20px; padding: 16px; background: #f9f9f9; border-radius: 4px;">';
      html +=
        '<div class="field-group-title" style="font-weight: 500; color: var(--primary-color, #6200ee); margin-bottom: 12px; font-size: 14px; text-transform: uppercase;">Members & Owners</div>';
      for (const [fieldName, attribute] of memberFields) {
        html += this.renderField(fieldName, attribute);
      }
      html += '</div>';
    }

    return html;
  }

  private renderField(fieldName: string, attribute: any): string {
    const value = this.group?.[fieldName];
    const label = this.getFieldLabel(fieldName);
    const required = attribute.required ? 'required' : '';

    if (attribute.type === 'array') {
      const arrayValue = Array.isArray(value) ? value.join('\n') : '';

      // Special handling for member/owner fields with add/delete buttons
      if (fieldName === 'member' || fieldName === 'owner') {
        return `
          <div class="form-group" style="margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 8px; font-weight: 500;">${this.escapeHtml(label)}</label>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
              <input type="text" id="${fieldName}-add-input" placeholder="Search DN or email..." style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" list="${fieldName}-suggestions" />
              <datalist id="${fieldName}-suggestions"></datalist>
              <button type="button" class="btn-add-${fieldName}" style="padding: 8px 16px; background: var(--primary-color, #6200ee); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                <span class="material-icons" style="font-size: 16px;">add</span>
                Add
              </button>
            </div>
            <textarea name="${this.escapeHtml(fieldName)}" id="${fieldName}-list" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; min-height: 120px; font-family: 'Roboto', sans-serif;" ${required}>${this.escapeHtml(arrayValue)}</textarea>
            <div style="font-size: 12px; color: #666; margin-top: 4px;">
              One DN per line. Type to search for users, or enter DN/email manually. Select a line and press Delete to remove.
            </div>
          </div>
        `;
      }

      return `
        <div class="form-group" style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px; font-weight: 500;">${this.escapeHtml(label)}</label>
          <textarea name="${this.escapeHtml(fieldName)}" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; min-height: 80px; font-family: 'Roboto', sans-serif;" ${required}>${this.escapeHtml(arrayValue)}</textarea>
          <div style="font-size: 12px; color: #666; margin-top: 4px;">Enter one value per line</div>
        </div>
      `;
    }

    if (attribute.type === 'number' || attribute.type === 'integer') {
      return `
        <div class="form-group" style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px; font-weight: 500;">${this.escapeHtml(label)}</label>
          <input type="number" name="${this.escapeHtml(fieldName)}" value="${value || ''}" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;" ${required} />
        </div>
      `;
    }

    // String field
    const type = fieldName.toLowerCase().includes('mail') ? 'email' : 'text';
    return `
      <div class="form-group" style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 8px; font-weight: 500;">${this.escapeHtml(label)}</label>
        <input type="${type}" name="${this.escapeHtml(fieldName)}" value="${this.escapeHtml(String(value || ''))}" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;" ${required} />
      </div>
    `;
  }

  private getFieldLabel(fieldName: string): string {
    const labelMap: Record<string, string> = {
      cn: 'Group Name',
      description: 'Description',
      member: 'Members',
      owner: 'Owners',
      mail: 'Email Address',
      twakeMailboxType: 'Mailbox Type',
    };
    return (
      labelMap[fieldName] ||
      fieldName
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .replace(/^./, str => str.toUpperCase())
    );
  }

  private attachEventListeners(): void {
    const form = document.getElementById('group-edit-form') as HTMLFormElement;
    if (form) {
      form.addEventListener('submit', e => this.handleSubmit(e));
    }

    const deleteBtn = document.getElementById('delete-group-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.handleDelete());
    }

    const moveBtn = document.getElementById('move-group-btn');
    if (moveBtn) {
      moveBtn.addEventListener('click', () => this.handleMove());
    }

    // Attach listeners for member/owner add buttons
    const addMemberBtn = this.container.querySelector('.btn-add-member');
    if (addMemberBtn) {
      addMemberBtn.addEventListener('click', () =>
        this.handleAddMember('member')
      );
    }

    const addOwnerBtn = this.container.querySelector('.btn-add-owner');
    if (addOwnerBtn) {
      addOwnerBtn.addEventListener('click', () =>
        this.handleAddMember('owner')
      );
    }

    // Handle Delete key for removing members/owners
    ['member', 'owner'].forEach(fieldName => {
      const textarea = document.getElementById(
        `${fieldName}-list`
      ) as HTMLTextAreaElement;
      if (textarea) {
        textarea.addEventListener('keydown', e => {
          if (e.key === 'Delete') {
            this.handleDeleteMember(textarea, e);
          }
        });
      }

      // Add autocomplete for member/owner inputs
      const input = document.getElementById(
        `${fieldName}-add-input`
      ) as HTMLInputElement;
      if (input) {
        let searchTimeout: number;
        input.addEventListener('input', () => {
          clearTimeout(searchTimeout);
          searchTimeout = window.setTimeout(() => {
            this.searchUsers(input.value, fieldName);
          }, 300);
        });
      }
    });
  }

  private async searchUsers(query: string, fieldName: string): Promise<void> {
    if (!query || query.length < 2) return;

    try {
      // Search for users by CN, UID, or mail
      const response = await fetch(
        `${this.api['baseUrl']}/api/v1/ldap/search?filter=(|(cn=*${encodeURIComponent(query)}*)(uid=*${encodeURIComponent(query)}*)(mail=*${encodeURIComponent(query)}*))`
      );

      if (!response.ok) return;

      const results = await response.json();
      const datalist = document.getElementById(
        `${fieldName}-suggestions`
      ) as HTMLDataListElement;

      if (!datalist) return;

      datalist.innerHTML = results
        .slice(0, 10)
        .map((user: any) => {
          const label =
            user.cn?.[0] || user.uid?.[0] || user.mail?.[0] || user.dn;
          return `<option value="${this.escapeHtml(user.dn)}">${this.escapeHtml(label)}</option>`;
        })
        .join('');
    } catch (error) {
      console.error('Failed to search users:', error);
    }
  }

  private async handleAddMember(fieldName: 'member' | 'owner'): Promise<void> {
    const input = document.getElementById(
      `${fieldName}-add-input`
    ) as HTMLInputElement;
    const textarea = document.getElementById(
      `${fieldName}-list`
    ) as HTMLTextAreaElement;

    if (!input || !textarea) return;

    const valueToAdd = input.value.trim();
    if (!valueToAdd) {
      alert('Please enter a DN or email address');
      return;
    }

    // Get current members/owners
    const currentValues = textarea.value
      .split('\n')
      .map(v => v.trim())
      .filter(v => v);

    // Check if already exists
    if (currentValues.includes(valueToAdd)) {
      alert(`This ${fieldName} already exists`);
      return;
    }

    // Add to list
    currentValues.push(valueToAdd);
    textarea.value = currentValues.join('\n');

    // Clear input
    input.value = '';
    input.focus();
  }

  private handleDeleteMember(
    textarea: HTMLTextAreaElement,
    e: KeyboardEvent
  ): void {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    // Find the line(s) being selected
    const lines = value.split('\n');
    let currentPos = 0;
    let startLine = 0;
    let endLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length + 1; // +1 for newline
      if (currentPos <= start && start < currentPos + lineLength) {
        startLine = i;
      }
      if (currentPos <= end && end <= currentPos + lineLength) {
        endLine = i;
        break;
      }
      currentPos += lineLength;
    }

    // Remove selected lines
    e.preventDefault();
    const newLines = lines.filter((_, i) => i < startLine || i > endLine);
    textarea.value = newLines.join('\n');
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();

    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const updates: Record<string, unknown> = {};

    for (const [key, value] of (formData as any).entries()) {
      if (this.schema?.attributes[key]?.type === 'array') {
        updates[key] = (value as string)
          .split('\n')
          .map(v => v.trim())
          .filter(v => v);
      } else if (
        this.schema?.attributes[key]?.type === 'number' ||
        this.schema?.attributes[key]?.type === 'integer'
      ) {
        updates[key] = Number(value);
      } else {
        updates[key] = value;
      }
    }

    try {
      // Check if cn has changed - if so, use rename API instead
      if (updates.cn && this.group?.cn) {
        const oldCn = Array.isArray(this.group.cn)
          ? this.group.cn[0]
          : this.group.cn;
        const newCn = updates.cn as string;

        if (oldCn !== newCn) {
          // Remove cn from updates
          delete updates.cn;

          // First rename the group
          await this.api.renameGroup(this.groupDn, newCn);

          // Update the groupDn for subsequent operations
          const newDn = this.groupDn.replace(
            new RegExp(`^cn=${oldCn},`),
            `cn=${newCn},`
          );
          this.groupDn = newDn;

          // If there are other updates, apply them to the renamed group
          if (Object.keys(updates).length > 0) {
            await this.api.updateGroup(this.groupDn, updates);
          }
        } else {
          // cn hasn't changed, just do a normal update
          await this.api.updateGroup(this.groupDn, updates);
        }
      } else {
        // No cn change, normal update
        await this.api.updateGroup(this.groupDn, updates);
      }

      alert('Group updated successfully!');
      if (this.saveCallback) {
        this.saveCallback();
      }
    } catch (error) {
      console.error('Failed to update group:', error);
      alert(`Failed to update group: ${(error as Error).message}`);
    }
  }

  private async handleMove(): Promise<void> {
    if (!this.group) return;

    // Get current organization DN from twakeDepartmentLink attribute
    const currentOrgDn = (this.group as any).twakeDepartmentLink as
      | string
      | undefined;

    if (!currentOrgDn) {
      alert(
        'Cannot move group: no organization link attribute found. This group may not support move operation.'
      );
      return;
    }

    // Extract group cn from DN
    const cnMatch = this.groupDn.match(/^cn=([^,]+)/);
    const cn = cnMatch ? cnMatch[1] : this.groupDn;

    const modal = new MoveGroupModal(
      this.api,
      currentOrgDn,
      async targetOrgDn => {
        try {
          await this.api.moveGroup(cn, targetOrgDn);
          alert('Group moved successfully!');

          // Reload the group
          await this.loadGroup();
          this.render();
          this.attachEventListeners();

          if (this.saveCallback) {
            this.saveCallback();
          }
        } catch (error) {
          console.error('Failed to move group:', error);
          alert(`Failed to move group: ${(error as Error).message}`);
        }
      }
    );

    await modal.show();
  }

  private async handleDelete(): Promise<void> {
    if (
      !confirm(
        `Are you sure you want to delete this group?\n\n${this.groupDn}\n\nThis action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      await this.api.deleteEntry(this.groupDn);
      alert('Group deleted successfully!');
      this.container.innerHTML = `
        <div class="empty-state">
          <span class="material-icons">group</span>
          <p>Group deleted. Select another group to edit.</p>
        </div>
      `;
    } catch (error) {
      console.error('Failed to delete group:', error);
      alert(`Failed to delete group: ${(error as Error).message}`);
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
}
