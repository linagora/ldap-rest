/**
 * LDAP User Editor - Pointer Field Component
 */

import type { PointerOption, SchemaAttribute } from '../types';
import type { UserApiClient } from '../api/UserApiClient';

export class PointerField {
  private api: UserApiClient;
  private attribute: SchemaAttribute;
  private fieldName: string;
  private value: string | string[];
  private onChange: (value: string | string[]) => void;
  private options: PointerOption[] = [];

  constructor(
    api: UserApiClient,
    fieldName: string,
    attribute: SchemaAttribute,
    value: string | string[],
    onChange: (value: string | string[]) => void
  ) {
    this.api = api;
    this.fieldName = fieldName;
    this.attribute = attribute;
    this.value = value;
    this.onChange = onChange;
  }

  async init(): Promise<void> {
    await this.loadOptions();
  }

  private async loadOptions(): Promise<void> {
    try {
      const branch =
        this.attribute.type === 'array'
          ? this.attribute.items?.branch?.[0]
          : this.attribute.branch?.[0];

      if (!branch) {
        this.options = [];
        return;
      }

      this.options = await this.api.getPointerOptions(branch);
    } catch (error) {
      console.error('Failed to load pointer options:', error);
      this.options = [];
    }
  }

  render(): string {
    const isArray = this.attribute.type === 'array';
    const isRequired = this.attribute.required || false;

    if (isArray) {
      return this.renderArray(isRequired);
    }
    return this.renderSingle(isRequired);
  }

  private renderSingle(required: boolean): string {
    const currentValue = Array.isArray(this.value) ? this.value[0] || '' : this.value || '';

    return `
      <div class="form-group">
        <label class="form-label">
          ${this.fieldName}
          ${required ? '<span class="required">*</span>' : ''}
        </label>
        <select
          class="form-select pointer-field-select"
          data-field="${this.fieldName}"
          ${required ? 'required' : ''}
        >
          <option value="">Select...</option>
          ${this.options
            .map(
              opt => `
            <option value="${opt.dn}" ${currentValue === opt.dn ? 'selected' : ''}>
              ${opt.label}
            </option>
          `
            )
            .join('')}
        </select>
      </div>
    `;
  }

  private renderArray(required: boolean): string {
    const values = Array.isArray(this.value) ? this.value : [];

    return `
      <div class="form-group">
        <label class="form-label">
          ${this.fieldName}
          ${required ? '<span class="required">*</span>' : ''}
        </label>
        <div class="array-field" data-field="${this.fieldName}">
          ${values
            .map(
              (val, idx) => `
            <div class="array-item" data-index="${idx}">
              <select class="form-select pointer-array-item">
                <option value="">Select...</option>
                ${this.options
                  .map(
                    opt => `
                  <option value="${opt.dn}" ${val === opt.dn ? 'selected' : ''}>
                    ${opt.label}
                  </option>
                `
                  )
                  .join('')}
              </select>
              <button type="button" class="btn btn-secondary btn-icon remove-array-item">
                <span class="material-icons">remove</span>
              </button>
            </div>
          `
            )
            .join('')}
          <button type="button" class="btn btn-secondary add-array-item">
            <span class="material-icons">add</span>
            Add ${this.fieldName}
          </button>
        </div>
      </div>
    `;
  }

  attachHandlers(container: HTMLElement): void {
    if (this.attribute.type === 'array') {
      this.attachArrayHandlers(container);
    } else {
      this.attachSingleHandlers(container);
    }
  }

  private attachSingleHandlers(container: HTMLElement): void {
    const select = container.querySelector(
      `select[data-field="${this.fieldName}"]`
    ) as HTMLSelectElement;

    select?.addEventListener('change', () => {
      this.onChange(select.value);
    });
  }

  private attachArrayHandlers(container: HTMLElement): void {
    const arrayContainer = container.querySelector(
      `.array-field[data-field="${this.fieldName}"]`
    );
    if (!arrayContainer) return;

    // Handle item change
    arrayContainer.querySelectorAll('.pointer-array-item').forEach((select, idx) => {
      select.addEventListener('change', () => {
        const values = Array.isArray(this.value) ? [...this.value] : [];
        values[idx] = (select as HTMLSelectElement).value;
        this.onChange(values);
      });
    });

    // Handle remove
    arrayContainer.querySelectorAll('.remove-array-item').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const values = Array.isArray(this.value) ? [...this.value] : [];
        values.splice(idx, 1);
        this.onChange(values);
      });
    });

    // Handle add
    const addBtn = arrayContainer.querySelector('.add-array-item');
    addBtn?.addEventListener('click', () => {
      const values = Array.isArray(this.value) ? [...this.value] : [];
      values.push('');
      this.onChange(values);
    });
  }
}
