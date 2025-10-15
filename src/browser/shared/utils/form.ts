/**
 * Form utility functions
 * @module browser/shared/utils/form
 */

import { escapeHtml, toTitleCase } from './dom';
import type { SchemaAttribute, PointerOption } from '../types';

/**
 * Get user-friendly field label from field name
 */
export function getFieldLabel(
  fieldName: string,
  attribute?: SchemaAttribute,
  customLabels?: Record<string, string>
): string {
  // Check custom labels first
  if (customLabels && customLabels[fieldName]) {
    return customLabels[fieldName];
  }

  // Common label mappings
  const labelMap: Record<string, string> = {
    ou: 'Unit Name',
    l: 'Location',
    telephoneNumber: 'Phone Number',
    facsimileTelephoneNumber: 'Fax Number',
    postalAddress: 'Postal Address',
    twakeDepartmentPath: 'Department Path',
    twakeLocalAdminLink: 'Local Administrators',
    twakeMailboxType: 'Mailbox Type',
  };

  if (labelMap[fieldName]) {
    return labelMap[fieldName];
  }

  // Convert to title case
  return toTitleCase(fieldName);
}

/**
 * Generate HTML for a form field based on schema attribute
 */
export async function generateFormField(
  fieldName: string,
  attribute: SchemaAttribute,
  options?: {
    customLabels?: Record<string, string>;
    pointerOptionsLoader?: (branch: string) => Promise<PointerOption[]>;
  }
): Promise<string> {
  const label = getFieldLabel(fieldName, attribute, options?.customLabels);
  const required = attribute.required ? 'required' : '';
  const labelClass = attribute.required ? 'required' : '';

  let fieldHtml = '';

  if (attribute.type === 'pointer') {
    // Pointer field - load options and display select
    const branch = attribute.branch?.[0];
    if (branch && options?.pointerOptionsLoader) {
      const pointerOptions = await options.pointerOptionsLoader(branch);
      fieldHtml = `
        <div class="form-group">
          <label for="${escapeHtml(fieldName)}" class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
          <select id="${escapeHtml(fieldName)}" name="${escapeHtml(fieldName)}" class="form-select" ${required}>
            <option value="">Select...</option>
            ${pointerOptions
              .map(
                opt => `
              <option value="${escapeHtml(opt.dn)}">${escapeHtml(opt.label)}</option>
            `
              )
              .join('')}
          </select>
          ${fieldName === 'twakeMailboxType' ? '<div class="help-text">Select "mailingList" or "teamMailbox" to enable mail functionality</div>' : ''}
        </div>
      `;
    } else {
      // Fallback if no branch defined
      fieldHtml = `
        <div class="form-group">
          <label for="${escapeHtml(fieldName)}" class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
          <input type="text" id="${escapeHtml(fieldName)}" name="${escapeHtml(fieldName)}" ${required} />
          <div class="help-text">Enter DN (Distinguished Name)</div>
        </div>
      `;
    }
  } else if (
    attribute.type === 'array' &&
    attribute.items?.type === 'pointer'
  ) {
    // Array of pointers - will be handled dynamically
    const branch = attribute.items.branch?.[0];
    if (branch) {
      fieldHtml = `
        <div class="form-group">
          <label class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
          <div class="array-field pointer-array-field" data-field="${escapeHtml(fieldName)}" data-branch="${escapeHtml(branch)}">
            <button type="button" class="btn btn-secondary add-pointer-item" data-field="${escapeHtml(fieldName)}">
              <span class="material-icons">add</span>
              Add ${escapeHtml(label)}
            </button>
          </div>
          <input type="hidden" name="${escapeHtml(fieldName)}" id="${escapeHtml(fieldName)}-hidden" value="" />
        </div>
      `;
    } else {
      // Fallback
      fieldHtml = `
        <div class="form-group">
          <label for="${escapeHtml(fieldName)}" class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
          <textarea id="${escapeHtml(fieldName)}" name="${escapeHtml(fieldName)}" ${required}></textarea>
          <div class="help-text">Enter one DN per line</div>
        </div>
      `;
    }
  } else if (attribute.type === 'array' && attribute.items?.type === 'string') {
    // Array field - use textarea
    fieldHtml = `
      <div class="form-group">
        <label for="${escapeHtml(fieldName)}" class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
        <textarea id="${escapeHtml(fieldName)}" name="${escapeHtml(fieldName)}" ${required}></textarea>
        <div class="help-text">Enter one value per line</div>
      </div>
    `;
  } else if (attribute.type === 'number' || attribute.type === 'integer') {
    // Number field
    fieldHtml = `
      <div class="form-group">
        <label for="${escapeHtml(fieldName)}" class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
        <input type="number" id="${escapeHtml(fieldName)}" name="${escapeHtml(fieldName)}" ${required} />
      </div>
    `;
  } else if (attribute.type === 'string') {
    // String field - use input with appropriate type
    const type =
      fieldName.toLowerCase().includes('password') ||
      fieldName.toLowerCase().includes('pwd')
        ? 'password'
        : fieldName.toLowerCase().includes('mail')
          ? 'email'
          : fieldName.toLowerCase().includes('phone') ||
              fieldName.toLowerCase().includes('telephone')
            ? 'tel'
            : 'text';
    fieldHtml = `
      <div class="form-group">
        <label for="${escapeHtml(fieldName)}" class="${escapeHtml(labelClass)}">${escapeHtml(label)}</label>
        <input type="${escapeHtml(type)}" id="${escapeHtml(fieldName)}" name="${escapeHtml(fieldName)}" ${required} />
      </div>
    `;
  }

  return fieldHtml;
}

/**
 * Process form data and convert types based on schema
 */
export function processFormData(
  formData: FormData,
  schema: Record<string, SchemaAttribute>
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // Collect form data
  for (const [key, value] of formData as any) {
    if (data[key]) {
      // Multiple values for the same key - convert to array
      if (!Array.isArray(data[key])) {
        data[key] = [data[key]];
      }
      (data[key] as unknown[]).push(value);
    } else {
      data[key] = value;
    }
  }

  // Process special field types based on schema
  for (const [fieldName, attribute] of Object.entries(schema)) {
    if (!data[fieldName]) continue;

    if (attribute.type === 'array' && typeof data[fieldName] === 'string') {
      // Split by newlines and filter empty lines
      data[fieldName] = (data[fieldName] as string)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    } else if (
      (attribute.type === 'number' || attribute.type === 'integer') &&
      typeof data[fieldName] === 'string'
    ) {
      // Convert to number
      data[fieldName] =
        attribute.type === 'integer'
          ? parseInt(data[fieldName] as string, 10)
          : parseFloat(data[fieldName] as string);
    }
  }

  // Clean up: remove empty strings, null values, and empty arrays
  const cleanedData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === '' || value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    cleanedData[key] = value;
  }

  return cleanedData;
}

/**
 * Collect values from pointer array fields
 */
export function collectPointerArrayValues(
  container: HTMLElement
): Record<string, string[]> {
  const values: Record<string, string[]> = {};

  const pointerArrayFields = container.querySelectorAll('.pointer-array-field');
  pointerArrayFields.forEach(field => {
    const fieldName = field.getAttribute('data-field');
    if (!fieldName) return;

    const selects = field.querySelectorAll(
      '.pointer-array-select'
    ) as NodeListOf<HTMLSelectElement>;
    const fieldValues = Array.from(selects)
      .map(select => select.value)
      .filter(val => val); // Remove empty values

    if (fieldValues.length > 0) {
      values[fieldName] = fieldValues;
    }
  });

  return values;
}

/**
 * Group schema fields by category
 */
export function groupSchemaFields(
  schema: Record<string, SchemaAttribute>,
  categorizer?: (fieldName: string, attribute: SchemaAttribute) => string | null
): Map<string, [string, SchemaAttribute][]> {
  const groups = new Map<string, [string, SchemaAttribute][]>();

  for (const [fieldName, attribute] of Object.entries(schema)) {
    if (attribute.fixed) continue;
    if (fieldName === 'objectClass') continue;

    const category = categorizer
      ? categorizer(fieldName, attribute)
      : attribute.group || 'default';

    if (category === null) continue; // Skip this field

    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push([fieldName, attribute]);
  }

  return groups;
}
