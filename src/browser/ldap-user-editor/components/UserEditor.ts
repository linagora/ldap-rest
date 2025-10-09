/**
 * LDAP User Editor - User Editor Component
 */

import type { LdapUser, Schema, SchemaAttribute } from '../types';
import type { UserApiClient } from '../api/UserApiClient';
import { PointerField } from './PointerField';

export class UserEditor {
  private container: HTMLElement;
  private api: UserApiClient;
  private userDn: string;
  private user: LdapUser | null = null;
  private schema: Schema | null = null;
  private formData: Partial<LdapUser> = {};
  private pointerFields: Map<string, PointerField> = new Map();
  private onSaved?: () => void;
  private onDeleted?: () => void;
  private ldapBase: string = '';

  /**
   * Escape HTML special characters to prevent XSS attacks
   * Reference: https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
   */
  private static escapeHtml(text: unknown): string {
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

  constructor(
    container: HTMLElement,
    api: UserApiClient,
    userDn: string,
    onSaved?: () => void,
    onDeleted?: () => void
  ) {
    this.container = container;
    this.api = api;
    this.userDn = userDn;
    this.onSaved = onSaved;
    this.onDeleted = onDeleted;
  }

  async init(): Promise<void> {
    try {
      this.showLoading();
      await this.loadUserAndSchema();
      this.render();
      await this.initPointerFields();
      this.attachHandlers();
    } catch (error) {
      this.showError((error as Error).message);
    }
  }

  private showLoading(): void {
    this.container.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <p style="margin-top: 1rem">Loading user data...</p>
      </div>
    `;
  }

  private showError(message: string): void {
    this.container.innerHTML = `
      <div class="alert alert-error">
        <span class="material-icons">error</span>
        <div>${UserEditor.escapeHtml(message)}</div>
      </div>
    `;
  }

  private async loadUserAndSchema(): Promise<void> {
    const config = await this.api.getConfig();
    this.ldapBase = config.ldapBase;

    // Find users resource in flatResources array
    const usersResource = config.features?.flatResources?.find(
      r => r.pluralName === 'users' || r.name === 'users'
    );

    const schemaUrl = usersResource?.schemaUrl;

    if (!schemaUrl) {
      throw new Error('Users schema not configured');
    }

    [this.schema, this.user] = await Promise.all([
      this.api.getSchema(schemaUrl),
      this.api.getUser(this.userDn),
    ]);

    // Replace __LDAP_BASE__ placeholder in schema branches
    if (this.schema) {
      this.replacePlaceholders(this.schema);
    }

    this.formData = { ...this.user };
  }

  private replacePlaceholders(schema: Schema): void {
    for (const attr of Object.values(schema.attributes)) {
      if (attr.branch) {
        attr.branch = attr.branch.map(b =>
          b.replace(/__LDAP_BASE__/g, this.ldapBase)
        );
      }
      if (attr.items?.branch) {
        attr.items.branch = attr.items.branch.map(b =>
          b.replace(/__LDAP_BASE__/g, this.ldapBase)
        );
      }
    }
  }

  private getFirstValue(value: unknown): string {
    if (!value) return '';
    if (Array.isArray(value)) return value[0] || '';
    return String(value);
  }

  private getFieldByRole(role: string): string {
    if (!this.schema || !this.user) return '';

    const field = Object.entries(this.schema.attributes).find(
      ([, attr]) => attr.role === role
    );

    if (!field) return '';
    const [fieldName] = field;
    return this.getFirstValue(this.user[fieldName]);
  }

  private render(): void {
    if (!this.user || !this.schema) return;

    const displayName = this.getFieldByRole('displayName');
    const identifier = this.getFirstValue(
      this.user[this.schema.entity.mainAttribute]
    );
    const userName = displayName || identifier || 'User';

    this.container.innerHTML = `
      <div class="editor-container">
        <div class="editor-header">
          <span class="material-icons">person</span>
          <div class="editor-title">
            <h3>${UserEditor.escapeHtml(userName)}</h3>
            <div class="dn">${UserEditor.escapeHtml(this.userDn)}</div>
          </div>
        </div>

        <div id="alert-container"></div>

        <form id="user-edit-form" class="editor-form">
          ${this.renderFormSections()}

          <div class="editor-actions" style="margin-top: 2rem; justify-content: space-between">
            <button type="button" class="btn btn-secondary" id="delete-user-btn" style="background: #d32f2f; color: white;">
              <span class="material-icons">person_remove</span>
              Delete User
            </button>
            <button type="submit" class="btn btn-primary">
              <span class="material-icons">save</span>
              Save Changes
            </button>
          </div>
        </form>
      </div>
    `;
  }

  private renderFormSections(): string {
    if (!this.schema) return '';

    // Group fields by the 'group' attribute from schema
    const groupedFields: Record<string, string[]> = {};
    const ungroupedFields: string[] = [];

    for (const [fieldName, attr] of Object.entries(this.schema.attributes)) {
      // Skip objectClass (it's fixed)
      if (fieldName === 'objectClass') continue;

      if (attr.group) {
        if (!groupedFields[attr.group]) {
          groupedFields[attr.group] = [];
        }
        groupedFields[attr.group].push(fieldName);
      } else {
        ungroupedFields.push(fieldName);
      }
    }

    // Render grouped sections
    let html = Object.entries(groupedFields)
      .map(
        ([title, fields]) => `
      <div class="form-section">
        <div class="form-section-title">${UserEditor.escapeHtml(title)}</div>
        <div class="form-row">
          ${fields
            .map(field => this.renderField(field))
            .filter(f => f)
            .join('')}
        </div>
      </div>
    `
      )
      .join('');

    // Render ungrouped fields in a default section if any
    if (ungroupedFields.length > 0) {
      html += `
      <div class="form-section">
        <div class="form-section-title">Other Fields</div>
        <div class="form-row">
          ${ungroupedFields
            .map(field => this.renderField(field))
            .filter(f => f)
            .join('')}
        </div>
      </div>
    `;
    }

    return html;
  }

  private renderField(fieldName: string): string {
    const attr = this.schema?.attributes[fieldName];
    if (!attr) return '';

    // Skip fixed fields - they cannot be edited
    if (attr.fixed) {
      return '';
    }

    // Show identifier fields as disabled
    if (attr.role === 'identifier') {
      return this.renderIdentifierField(fieldName);
    }

    // Pointer fields
    if (attr.type === 'pointer' || attr.items?.type === 'pointer') {
      return `<div id="pointer-${UserEditor.escapeHtml(fieldName)}"></div>`;
    }

    // Array fields
    if (attr.type === 'array') {
      return this.renderArrayField(fieldName, attr);
    }

    // Number fields
    if (attr.type === 'number' || attr.type === 'integer') {
      return this.renderNumberField(fieldName, attr);
    }

    // String fields
    return this.renderStringField(fieldName, attr);
  }

  private renderIdentifierField(fieldName: string): string {
    const value = this.formData[fieldName];
    const displayValue = Array.isArray(value) ? value[0] : value || '';

    return `
      <div class="form-group">
        <label class="form-label">${UserEditor.escapeHtml(fieldName)}</label>
        <input
          type="text"
          class="form-input"
          value="${UserEditor.escapeHtml(displayValue)}"
          disabled
        />
      </div>
    `;
  }

  private renderStringField(fieldName: string, attr: SchemaAttribute): string {
    const value = this.formData[fieldName] || '';
    const inputType = attr.test?.includes('@')
      ? 'email'
      : fieldName === 'userPassword'
        ? 'password'
        : 'text';

    return `
      <div class="form-group">
        <label class="form-label">
          ${UserEditor.escapeHtml(fieldName)}
          ${attr.required ? '<span class="required">*</span>' : ''}
        </label>
        <input
          type="${UserEditor.escapeHtml(inputType)}"
          class="form-input"
          name="${UserEditor.escapeHtml(fieldName)}"
          value="${UserEditor.escapeHtml(value)}"
          ${attr.required ? 'required' : ''}
        />
      </div>
    `;
  }

  private renderNumberField(fieldName: string, attr: SchemaAttribute): string {
    const value = this.formData[fieldName] || '';

    return `
      <div class="form-group">
        <label class="form-label">
          ${UserEditor.escapeHtml(fieldName)}
          ${attr.required ? '<span class="required">*</span>' : ''}
        </label>
        <input
          type="number"
          class="form-input"
          name="${UserEditor.escapeHtml(fieldName)}"
          value="${UserEditor.escapeHtml(value)}"
          ${attr.required ? 'required' : ''}
        />
      </div>
    `;
  }

  private renderArrayField(fieldName: string, attr: SchemaAttribute): string {
    const values = Array.isArray(this.formData[fieldName])
      ? (this.formData[fieldName] as string[])
      : [];

    const inputType =
      attr.items?.type === 'string' && attr.items?.test?.includes('@')
        ? 'email'
        : 'text';

    return `
      <div class="form-group">
        <label class="form-label">
          ${UserEditor.escapeHtml(fieldName)}
          ${attr.required ? '<span class="required">*</span>' : ''}
        </label>
        <div class="array-field" data-field="${UserEditor.escapeHtml(fieldName)}">
          ${values
            .map(
              (val, idx) => `
            <div class="array-item" data-index="${idx}">
              <input
                type="${UserEditor.escapeHtml(inputType)}"
                class="form-input array-string-item"
                value="${UserEditor.escapeHtml(val)}"
              />
              <button type="button" class="btn btn-secondary btn-icon remove-array-item">
                <span class="material-icons">remove</span>
              </button>
            </div>
          `
            )
            .join('')}
          <button type="button" class="btn btn-secondary add-array-item" data-field="${UserEditor.escapeHtml(fieldName)}">
            <span class="material-icons">add</span>
            Add ${UserEditor.escapeHtml(fieldName)}
          </button>
        </div>
      </div>
    `;
  }

  private async initPointerFields(): Promise<void> {
    if (!this.schema) return;

    const pointerFieldNames = Object.entries(this.schema.attributes)
      .filter(
        ([, attr]) =>
          (attr.type === 'pointer' || attr.items?.type === 'pointer') &&
          !attr.fixed
      )
      .map(([name]) => name);

    for (const fieldName of pointerFieldNames) {
      const attr = this.schema.attributes[fieldName];
      const value = this.formData[fieldName] as string | string[];

      const pointerField = new PointerField(
        this.api,
        fieldName,
        attr,
        value,
        newValue => {
          this.formData[fieldName] = newValue;
          this.rerenderPointerField(fieldName);
        }
      );

      await pointerField.init();
      this.pointerFields.set(fieldName, pointerField);

      // Render into placeholder
      const placeholder = this.container.querySelector(`#pointer-${fieldName}`);
      if (placeholder) {
        placeholder.innerHTML = pointerField.render();
        pointerField.attachHandlers(placeholder as HTMLElement);
      }
    }
  }

  private rerenderPointerField(fieldName: string): void {
    const pointerField = this.pointerFields.get(fieldName);
    if (!pointerField) return;

    const placeholder = this.container.querySelector(`#pointer-${fieldName}`);
    if (placeholder) {
      placeholder.innerHTML = pointerField.render();
      pointerField.attachHandlers(placeholder as HTMLElement);
    }
  }

  private attachHandlers(): void {
    const form = this.container.querySelector('#user-edit-form');
    form?.addEventListener('submit', e => this.handleSubmit(e));

    // Delete button
    const deleteBtn = this.container.querySelector('#delete-user-btn');
    deleteBtn?.addEventListener('click', () => this.handleDelete());

    // String/number inputs
    this.container
      .querySelectorAll<HTMLInputElement>('input[name]')
      .forEach(input => {
        input.addEventListener('input', () => {
          const fieldName = input.name;
          const attr = this.schema?.attributes[fieldName];

          if (attr?.type === 'number' || attr?.type === 'integer') {
            this.formData[fieldName] = input.value
              ? parseInt(input.value, 10)
              : '';
          } else {
            this.formData[fieldName] = input.value;
          }
        });
      });

    // Array fields
    this.attachArrayFieldHandlers();
  }

  private attachArrayFieldHandlers(): void {
    // Handle array item changes
    this.container
      .querySelectorAll('.array-field')
      .forEach((arrayContainer: Element) => {
        const fieldName = arrayContainer.getAttribute('data-field');
        if (!fieldName) return;

        arrayContainer
          .querySelectorAll('.array-string-item')
          .forEach((input, idx) => {
            input.addEventListener('input', () => {
              const values = Array.isArray(this.formData[fieldName])
                ? [...(this.formData[fieldName] as string[])]
                : [];
              values[idx] = (input as HTMLInputElement).value;
              this.formData[fieldName] = values;
            });
          });

        arrayContainer
          .querySelectorAll('.remove-array-item')
          .forEach((btn, idx) => {
            btn.addEventListener('click', () => {
              const values = Array.isArray(this.formData[fieldName])
                ? [...(this.formData[fieldName] as string[])]
                : [];
              values.splice(idx, 1);
              this.formData[fieldName] = values;
              this.rerenderArrayField(fieldName);
            });
          });
      });

    // Handle add buttons
    this.container.querySelectorAll('.add-array-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const fieldName = btn.getAttribute('data-field');
        if (!fieldName) return;

        const values = Array.isArray(this.formData[fieldName])
          ? [...(this.formData[fieldName] as string[])]
          : [];
        values.push('');
        this.formData[fieldName] = values;
        this.rerenderArrayField(fieldName);
      });
    });
  }

  private rerenderArrayField(fieldName: string): void {
    const attr = this.schema?.attributes[fieldName];
    if (!attr) return;

    const arrayContainer = this.container.querySelector(
      `.array-field[data-field="${fieldName}"]`
    )?.parentElement;

    if (arrayContainer) {
      const newHtml =
        attr.type === 'pointer' || attr.items?.type === 'pointer'
          ? this.pointerFields.get(fieldName)?.render() || ''
          : this.renderArrayField(fieldName, attr);

      arrayContainer.outerHTML = newHtml;

      // Reattach handlers
      if (attr.type === 'pointer' || attr.items?.type === 'pointer') {
        const placeholder = this.container.querySelector(
          `#pointer-${fieldName}`
        );
        if (placeholder) {
          const pointerField = this.pointerFields.get(fieldName);
          pointerField?.attachHandlers(placeholder as HTMLElement);
        }
      } else {
        this.attachArrayFieldHandlers();
      }
    }
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();

    const alertContainer = this.container.querySelector('#alert-container');
    const submitBtn = this.container.querySelector(
      'button[type="submit"]'
    ) as HTMLButtonElement;

    if (alertContainer) alertContainer.innerHTML = '';
    if (submitBtn) submitBtn.disabled = true;

    try {
      await this.api.updateUser(this.userDn, this.formData);

      if (alertContainer) {
        alertContainer.innerHTML = `
          <div class="alert alert-success">
            <span class="material-icons">check_circle</span>
            <div>User updated successfully!</div>
          </div>
        `;
      }

      if (this.onSaved) this.onSaved();
    } catch (error) {
      if (alertContainer) {
        alertContainer.innerHTML = `
          <div class="alert alert-error">
            <span class="material-icons">error</span>
            <div>${UserEditor.escapeHtml((error as Error).message)}</div>
          </div>
        `;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  private async handleDelete(): Promise<void> {
    if (
      !confirm(`Are you sure you want to delete this user?\n\n${this.userDn}`)
    ) {
      return;
    }

    const alertContainer = this.container.querySelector('#alert-container');
    const deleteBtn = this.container.querySelector(
      '#delete-user-btn'
    ) as HTMLButtonElement;

    if (alertContainer) alertContainer.innerHTML = '';
    if (deleteBtn) deleteBtn.disabled = true;

    try {
      await this.api.deleteUser(this.userDn);

      if (alertContainer) {
        alertContainer.innerHTML = `
          <div class="alert alert-success">
            <span class="material-icons">check_circle</span>
            <div>User deleted successfully!</div>
          </div>
        `;
      }

      if (this.onDeleted) this.onDeleted();
    } catch (error) {
      if (alertContainer) {
        alertContainer.innerHTML = `
          <div class="alert alert-error">
            <span class="material-icons">error</span>
            <div>${UserEditor.escapeHtml((error as Error).message)}</div>
          </div>
        `;
      }
      if (deleteBtn) deleteBtn.disabled = false;
    }
  }

  async refresh(): Promise<void> {
    await this.init();
  }
}
