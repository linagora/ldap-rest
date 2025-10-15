/**
 * Unit Property Editor Component - Edits properties of a selected organizational unit
 */

import type { UnitApiClient } from '../api/UnitApiClient';
import type { LdapUnit, SchemaDefinition } from '../types';
import { MoveUnitModal } from './MoveUnitModal';

export class UnitPropertyEditor {
  private container: HTMLElement;
  private api: UnitApiClient;
  private unitDn: string;
  private unit: LdapUnit | null = null;
  private schema: SchemaDefinition | null = null;
  private saveCallback: (() => void) | null = null;

  constructor(container: HTMLElement, api: UnitApiClient, unitDn: string) {
    this.container = container;
    this.api = api;
    this.unitDn = unitDn;
  }

  async init(): Promise<void> {
    await this.loadUnit();
    await this.loadSchema();
    this.render();
    this.attachEventListeners();
  }

  private async loadUnit(): Promise<void> {
    this.unit = await this.api.getUnit(this.unitDn);
  }

  private async loadSchema(): Promise<void> {
    console.warn('[UnitPropertyEditor] Loading schema...');
    const config = await this.api.getConfig();

    // First check in features.organizations (from ldapOrganizations plugin)
    const orgsConfig = (config.features as any)?.organizations;
    console.warn('[UnitPropertyEditor] Organizations config:', orgsConfig);

    if (orgsConfig?.schemaUrl) {
      console.warn(
        '[UnitPropertyEditor] Loading schema from URL:',
        orgsConfig.schemaUrl
      );
      const response = await fetch(orgsConfig.schemaUrl);
      this.schema = await response.json();
      console.warn('[UnitPropertyEditor] Schema loaded from URL:', this.schema);
    } else if (orgsConfig?.schema) {
      console.warn('[UnitPropertyEditor] Using schema from config');
      this.schema = orgsConfig.schema;
    } else {
      // Fallback: check in flatResources
      console.warn('[UnitPropertyEditor] Falling back to flatResources');
      const unitsResource = config.features?.flatResources?.find(
        r => r.pluralName === 'organizations' || r.name === 'organizations'
      );

      if (unitsResource?.schemaUrl) {
        const response = await fetch(unitsResource.schemaUrl);
        this.schema = await response.json();
      } else if (unitsResource?.schema) {
        this.schema = unitsResource.schema;
      } else {
        console.warn('[UnitPropertyEditor] No schema found, using default');
        // Create a minimal default schema
        this.schema = {
          entity: {
            objectClass: ['organizationalUnit'],
          },
          attributes: {
            ou: { type: 'string', required: true },
            description: { type: 'string' },
          },
        };
      }
    }
  }

  onSave(callback: () => void): void {
    this.saveCallback = callback;
  }

  private render(): void {
    if (!this.unit) return;

    this.container.innerHTML = `
      <div class="unit-property-editor">
        <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
          <span class="material-icons">business</span>
          Edit Organizational Unit
        </h3>
        <form id="unit-edit-form">
          ${this.renderFields()}
          <div class="form-actions" style="margin-top: 24px; padding-top: 24px; border-top: 1px solid #e0e0e0; display: flex; gap: 12px; justify-content: space-between;">
            <button type="button" id="move-unit-btn" class="btn btn-secondary" style="background: #757575; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
              <span class="material-icons" style="font-size: 18px;">drive_file_move</span>
              Move
            </button>
            <div style="display: flex; gap: 12px;">
              <button type="button" id="delete-unit-btn" class="btn btn-danger" style="background: #d32f2f; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span class="material-icons" style="font-size: 18px;">delete</span>
                Delete Unit
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
    if (!this.unit || !this.schema) {
      return '<div>Loading...</div>';
    }

    let html = '';

    // Group fields by category
    const basicFields: [string, any][] = [];
    const otherFields: [string, any][] = [];

    for (const [fieldName, attribute] of Object.entries(
      this.schema.attributes
    )) {
      if (attribute.fixed || fieldName === 'objectClass') continue;

      if (fieldName === 'ou' || fieldName === 'description') {
        basicFields.push([fieldName, attribute]);
      } else {
        otherFields.push([fieldName, attribute]);
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

    // Additional Properties
    if (otherFields.length > 0) {
      html +=
        '<div class="field-group" style="margin-bottom: 20px; padding: 16px; background: #f9f9f9; border-radius: 4px;">';
      html +=
        '<div class="field-group-title" style="font-weight: 500; color: var(--primary-color, #6200ee); margin-bottom: 12px; font-size: 14px; text-transform: uppercase;">Additional Properties</div>';
      for (const [fieldName, attribute] of otherFields) {
        html += this.renderField(fieldName, attribute);
      }
      html += '</div>';
    }

    return html;
  }

  private renderField(fieldName: string, attribute: any): string {
    const value = this.unit?.[fieldName];
    const label = this.getFieldLabel(fieldName);
    const required = attribute.required ? 'required' : '';

    if (attribute.type === 'array') {
      const arrayValue = Array.isArray(value) ? value.join('\n') : '';
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
    return `
      <div class="form-group" style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 8px; font-weight: 500;">${this.escapeHtml(label)}</label>
        <input type="text" name="${this.escapeHtml(fieldName)}" value="${this.escapeHtml(String(value || ''))}" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;" ${required} />
      </div>
    `;
  }

  private getFieldLabel(fieldName: string): string {
    const labelMap: Record<string, string> = {
      ou: 'Organization Unit',
      description: 'Description',
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
    const form = document.getElementById('unit-edit-form') as HTMLFormElement;
    if (form) {
      form.addEventListener('submit', e => this.handleSubmit(e));
    }

    const deleteBtn = document.getElementById('delete-unit-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.handleDelete());
    }

    const moveBtn = document.getElementById('move-unit-btn');
    if (moveBtn) {
      moveBtn.addEventListener('click', () => this.handleMove());
    }
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
      await this.api.updateUnit(this.unitDn, updates);
      alert('Organizational unit updated successfully!');
      if (this.saveCallback) {
        this.saveCallback();
      }
    } catch (error) {
      console.error('Failed to update unit:', error);
      alert(`Failed to update unit: ${(error as Error).message}`);
    }
  }

  private async handleMove(): Promise<void> {
    if (!this.unit) return;

    // Extract parent DN from current unit DN
    const parentDn = this.unitDn.split(',').slice(1).join(',');

    const modal = new MoveUnitModal(this.api, parentDn, async targetOrgDn => {
      try {
        const result = await this.api.moveUnit(this.unitDn, targetOrgDn);
        alert('Unit moved successfully!');

        // Reload the unit with its new DN
        if (result.newDn) {
          this.unitDn = result.newDn;
          await this.loadUnit();
          this.render();
          this.attachEventListeners();
        }

        if (this.saveCallback) {
          this.saveCallback();
        }
      } catch (error) {
        console.error('Failed to move unit:', error);
        alert(`Failed to move unit: ${(error as Error).message}`);
      }
    });

    await modal.show();
  }

  private async handleDelete(): Promise<void> {
    if (
      !confirm(
        `Are you sure you want to delete this organizational unit?\n\n${this.unitDn}\n\nThis action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      await this.api.deleteEntry(this.unitDn);
      alert('Organizational unit deleted successfully!');
      this.container.innerHTML = `
        <div class="empty-state">
          <span class="material-icons">business</span>
          <p>Unit deleted. Select another unit to edit.</p>
        </div>
      `;
    } catch (error) {
      console.error('Failed to delete unit:', error);
      alert(`Failed to delete unit: ${(error as Error).message}`);
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
