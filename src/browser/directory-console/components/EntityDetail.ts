/**
 * Read-only view of one entry.
 *
 * It shows **every** attribute the entry carries, not the two the list already
 * showed: having to open an edit dialog to find out an organization's phone
 * number is the defect this replaces. Lifecycle actions sit next to the data
 * they change, and related entries are listed underneath.
 *
 * @module browser/directory-console/components/EntityDetail
 */

import { escapeHtml } from '../../shared/utils/dom';
import { attributeLabel, displayValue, entryValue } from '../format';
import type { Translator } from '../i18n';
import type { EntityDescriptor, Entry, SchemaAttribute } from '../types';

export interface DetailOptions {
  entity: EntityDescriptor;
  entry: Entry;
  translator: Translator;
  canWrite: boolean;
  canDelete: boolean;
  onEdit(): void;
  onDelete(): void;
  onStatus(state: string): void;
  onResetPassword(): void;
  /** Entries pointing at this one, or pointed at by it */
  relations?: {
    title: string;
    /** Attribute the list came from, so the card does not repeat it */
    attribute?: string;
    items: { id: string; label: string }[];
  };
  onOpenRelation?(id: string): void;
}

/** Read an entry value as a list of display strings. */
function values(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export class EntityDetail {
  private readonly options: DetailOptions;

  constructor(options: DetailOptions) {
    this.options = options;
  }

  /**
   * Render into a container.
   *
   * @param container element to fill
   */
  render(container: HTMLElement): void {
    const { entity, entry, translator, canWrite, canDelete } = this.options;
    const title = values(entryValue(entry, entity.mainAttribute))[0] || '';

    container.innerHTML = `
      <article class="dc-detail">
        <header class="dc-detail-header">
          <h2>${escapeHtml(title)}</h2>
          <div class="dc-detail-actions">
            ${
              canWrite
                ? `<button type="button" class="dc-button dc-button-primary" data-edit>${escapeHtml(
                    translator.t('app.edit')
                  )}</button>`
                : ''
            }
            ${this.statusMarkup()}
            ${
              canWrite && entity.password
                ? `<button type="button" class="dc-button" data-password>${escapeHtml(
                    translator.t('password.title')
                  )}</button>`
                : ''
            }
            ${
              canDelete
                ? `<button type="button" class="dc-button dc-button-danger" data-delete>${escapeHtml(
                    translator.t('app.delete')
                  )}</button>`
                : ''
            }
          </div>
        </header>

        <section class="dc-card">
          <h3>${escapeHtml(translator.t('detail.attributes'))}</h3>
          <dl class="dc-attributes">${this.attributesMarkup()}</dl>
        </section>

        ${this.relationsMarkup()}
      </article>`;

    this.bind(container);
  }

  /** Every attribute the schema knows, in schema order, empty ones included. */
  private attributesMarkup(): string {
    const { entity, entry, translator } = this.options;
    const rows: string[] = [];
    for (const [name, attr] of Object.entries(entity.schema.attributes)) {
      if (name === 'objectClass') continue;
      // A write-only attribute has nothing to show: the API never returns it.
      if (attr.neverReturn) continue;
      // The related-entries section below shows this one in full.
      if (name === this.options.relations?.attribute) continue;
      const list = values(entryValue(entry, name));
      rows.push(`
        <div class="dc-attribute">
          <dt>${escapeHtml(this.label(name, attr))}</dt>
          <dd>${
            list.length === 0
              ? `<span class="dc-muted">${escapeHtml(translator.t('form.none'))}</span>`
              : list.map(value => this.valueMarkup(name, value)).join('')
          }</dd>
        </div>`);
    }
    return rows.join('');
  }

  private label(name: string, attr: SchemaAttribute): string {
    return attributeLabel(name, attr, this.options.translator.language);
  }

  /**
   * One value. An organization path is clickable — it is both the answer to
   * "where is this entry?" and the way to get there.
   *
   * "The way to get there" was a link to the tree and nothing more: it opened
   * on the root, leaving the reader to find the department again by hand. The
   * route already takes an organization (`#/organizations/<dn>`) and selects
   * it, and the entry names its own one through the `organizationLink` role,
   * so the link goes to the department it is naming.
   *
   * An organization carries a path and no link — the path *is* its own place
   * in the tree, not a way to somewhere else — so on its own card it stays
   * text. A link from an entry to itself is one more thing to click for
   * nothing.
   */
  private valueMarkup(name: string, value: string): string {
    const { entity, entry } = this.options;
    const link =
      name === entity.organizationPath && entity.organizationLink
        ? values(entryValue(entry, entity.organizationLink))[0]
        : undefined;
    if (link)
      return `<a href="#/organizations/${encodeURIComponent(
        link
      )}" class="dc-path-link" title="${escapeHtml(value)}">${escapeHtml(
        value
      )}</a>`;
    const shown = displayValue(entity.schema.attributes[name], value);
    return `<span class="dc-value" title="${escapeHtml(value)}">${escapeHtml(shown)}</span>`;
  }

  /** The states this account can be moved to, straight from the schema. */
  private statusMarkup(): string {
    const { entity, translator, canWrite } = this.options;
    if (!canWrite || !entity.accountStatus) return '';
    const states = entity.schema.attributes[entity.accountStatus]?.states;
    if (!states || Object.keys(states).length === 0) return '';
    return `
      <label class="dc-status">
        <span class="dc-visually-hidden">${escapeHtml(translator.t('status.change'))}</span>
        <select class="dc-input" data-status>
          <option value="">${escapeHtml(translator.t('status.change'))}</option>
          ${Object.keys(states)
            .map(state => {
              // A state the catalogue knows is translated; one the deployment
              // invented keeps the name the deployment gave it.
              const shown = translator.t(`state.${state}`);
              return `<option value="${escapeHtml(state)}">${escapeHtml(
                shown === `state.${state}` ? state : shown
              )}</option>`;
            })
            .join('')}
        </select>
      </label>`;
  }

  private relationsMarkup(): string {
    const { relations, translator } = this.options;
    if (!relations) return '';
    return `
      <section class="dc-card">
        <h3>${escapeHtml(relations.title)}</h3>
        ${
          relations.items.length === 0
            ? `<p class="dc-muted">${escapeHtml(translator.t('detail.emptyRelations'))}</p>`
            : `<ul class="dc-relations">${relations.items
                .map(
                  item =>
                    `<li><button type="button" class="dc-link" data-relation="${escapeHtml(
                      item.id
                    )}">${escapeHtml(item.label)}</button></li>`
                )
                .join('')}</ul>`
        }
      </section>`;
  }

  private bind(container: HTMLElement): void {
    container
      .querySelector('[data-edit]')
      ?.addEventListener('click', () => this.options.onEdit());
    container
      .querySelector('[data-delete]')
      ?.addEventListener('click', () => this.options.onDelete());
    container
      .querySelector('[data-password]')
      ?.addEventListener('click', () => this.options.onResetPassword());

    const status = container.querySelector<HTMLSelectElement>('[data-status]');
    status?.addEventListener('change', () => {
      if (!status.value) return;
      const state = status.value;
      status.value = '';
      this.options.onStatus(state);
    });

    for (const button of Array.from(
      container.querySelectorAll<HTMLElement>('[data-relation]')
    )) {
      button.addEventListener('click', () => {
        this.options.onOpenRelation?.(button.dataset.relation as string);
      });
    }
  }
}
