/**
 * Attribute table of one entry, annotated with the directory schema.
 * @module browser/ldap-browser/components/EntryView
 */

import { escapeHtml } from '../../shared/utils/dom';
import type { SchemaView } from '../schema';
import type { RawEntry } from '../types';

/** Operational attributes are shown apart from the ones the admin sets */
const OPERATIONAL_USAGE = new Set([
  'directoryOperation',
  'distributedOperation',
  'dSAOperation',
]);

export class EntryView {
  private container: HTMLElement;
  private schema: SchemaView | null;

  constructor(container: HTMLElement, schema: SchemaView | null) {
    this.container = container;
    this.schema = schema;
  }

  /** Draw the placeholder shown when nothing is selected */
  renderEmpty(): void {
    this.container.innerHTML = `
      <div class="ldap-browser-entry__empty">
        <span class="material-icons">description</span>
        <p>Select an entry in the tree</p>
      </div>`;
  }

  /**
   * Draw an error in place of the entry.
   *
   * @param message message to display
   */
  renderError(message: string): void {
    this.container.innerHTML = `<div class="ldap-browser-entry__error">${escapeHtml(
      message
    )}</div>`;
  }

  /** Draw a loading indicator */
  renderLoading(): void {
    this.container.innerHTML =
      '<div class="ldap-browser-entry__loading">Loading…</div>';
  }

  /**
   * Draw an entry: its DN, its object classes with the attributes they allow,
   * then the attribute table.
   *
   * @param entry entry to display
   */
  render(entry: RawEntry): void {
    const objectClasses = entry.attributes.objectClass?.values || [];
    const resolved = this.schema?.resolveAttributes(objectClasses);
    const mandatory = new Set(
      (resolved?.must || []).map(name => name.toLowerCase())
    );
    const present = new Set(
      Object.keys(entry.attributes).map(name =>
        name.split(';')[0].toLowerCase()
      )
    );

    const names = Object.keys(entry.attributes).sort((a, b) =>
      a.localeCompare(b)
    );
    const isOperational = (name: string): boolean => {
      const type = this.schema?.getAttributeType(name);
      return type ? OPERATIONAL_USAGE.has(type.usage) : false;
    };
    const userAttributes = names.filter(name => !isOperational(name));
    const operational = names.filter(isOperational);

    // Mandatory attributes the entry does not carry: the directory should
    // reject that, but a UI that hides it makes debugging harder
    const missing = (resolved?.must || []).filter(
      name => !present.has(name.toLowerCase())
    );

    this.container.innerHTML = `
      <div class="ldap-browser-entry">
        <h2 class="ldap-browser-entry__dn" title="${escapeHtml(entry.dn)}">
          <span class="material-icons">description</span>
          ${escapeHtml(entry.dn || '(root DSE)')}
        </h2>

        ${this.renderObjectClasses(objectClasses, resolved)}

        ${
          missing.length
            ? `<p class="ldap-browser-entry__warning">
                 Missing mandatory attribute(s): ${escapeHtml(missing.join(', '))}
               </p>`
            : ''
        }

        ${this.renderTable(entry, mandatory, userAttributes, 'Attributes')}
        ${
          operational.length
            ? this.renderTable(
                entry,
                mandatory,
                operational,
                'Operational attributes'
              )
            : ''
        }
      </div>`;
  }

  /**
   * Render the object class list and, when the schema is available, the
   * attributes those classes allow.
   *
   * @param objectClasses object classes of the entry
   * @param resolved mandatory and optional attributes they imply
   * @returns HTML of the section
   */
  private renderObjectClasses(
    objectClasses: string[],
    resolved?: { must: string[]; may: string[] }
  ): string {
    if (objectClasses.length === 0) return '';
    const chips = objectClasses
      .map(name => {
        const definition = this.schema?.getObjectClass(name);
        const title = definition
          ? `${definition.kind}${definition.desc ? ` — ${definition.desc}` : ''}`
          : 'unknown in schema';
        return `<span class="ldap-browser-chip${
          definition ? '' : ' ldap-browser-chip--unknown'
        }" title="${escapeHtml(title)}">${escapeHtml(name)}</span>`;
      })
      .join('');

    const allowed = resolved
      ? `<div class="ldap-browser-entry__allowed">
           <span><strong>Required:</strong> ${escapeHtml(
             resolved.must.join(', ') || '—'
           )}</span>
           <span><strong>Allowed:</strong> ${escapeHtml(
             resolved.may.join(', ') || '—'
           )}</span>
         </div>`
      : '';

    return `<div class="ldap-browser-entry__classes">${chips}</div>${allowed}`;
  }

  /**
   * Render one attribute table.
   *
   * @param entry entry being displayed
   * @param mandatory lowercase names of the mandatory attributes
   * @param names attributes to include, in display order
   * @param title heading of the table
   * @returns HTML of the table
   */
  private renderTable(
    entry: RawEntry,
    mandatory: Set<string>,
    names: string[],
    title: string
  ): string {
    if (names.length === 0) return '';
    const rows = names
      .map(name => {
        const attribute = entry.attributes[name];
        const type = this.schema?.getAttributeType(name);
        const isMandatory = mandatory.has(name.split(';')[0].toLowerCase());
        const tooltip = type
          ? [
              type.desc,
              type.syntax ? `syntax ${type.syntax}` : '',
              type.singleValue ? 'single-valued' : '',
              type.noUserModification ? 'read-only' : '',
            ]
              .filter(Boolean)
              .join(' — ')
          : 'unknown in schema';

        return `<tr>
          <th class="${isMandatory ? 'ldap-browser-attr--must' : ''}${
            type ? '' : ' ldap-browser-attr--unknown'
          }" title="${escapeHtml(tooltip)}">
            ${escapeHtml(name)}${isMandatory ? ' *' : ''}
          </th>
          <td>${this.renderValues(name, attribute)}</td>
        </tr>`;
      })
      .join('');

    return `<h3 class="ldap-browser-entry__section">${escapeHtml(title)}</h3>
      <table class="ldap-browser-entry__table"><tbody>${rows}</tbody></table>`;
  }

  /**
   * Render the values of one attribute: images as thumbnails, other binary
   * values as their size plus the base64 payload, text as text.
   *
   * @param name attribute name
   * @param attribute values and binary flag
   * @returns HTML of the value cell
   */
  private renderValues(
    name: string,
    attribute: { values: string[]; binary: boolean }
  ): string {
    return attribute.values
      .map(value => {
        if (attribute.binary && this.schema?.isImageAttribute(name))
          // Keep only base64 characters: the value ends up in an attribute
          return `<img class="ldap-browser-entry__photo" alt="${escapeHtml(
            name
          )}" src="data:image/jpeg;base64,${value.replace(/[^A-Za-z0-9+/=]/g, '')}" />`;
        if (attribute.binary)
          return `<details class="ldap-browser-entry__binary">
              <summary>${byteLength(value)} bytes (base64)</summary>
              <code>${escapeHtml(value)}</code>
            </details>`;
        return `<div class="ldap-browser-entry__value">${escapeHtml(value)}</div>`;
      })
      .join('');
  }
}

/**
 * Decoded size of a base64 payload, without decoding it.
 *
 * @param base64 base64-encoded value
 * @returns number of octets
 */
function byteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
