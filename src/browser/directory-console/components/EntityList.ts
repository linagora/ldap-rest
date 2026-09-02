/**
 * Table of entries, with one search box, paging and bulk actions.
 *
 * The columns are chosen from the schema's semantic roles, not from a
 * hardcoded list, so the table of an entity the deployment adds is readable
 * without a change here.
 *
 * A branch with tens of thousands of entries cannot be listed whole: below
 * `SEARCH_MINIMUM` characters the table says what to type instead of
 * pretending to load. The page size is remembered, because being handed ten
 * rows out of twelve thousand on every visit is not a default anyone chose.
 *
 * @module browser/directory-console/components/EntityList
 */

import { escapeHtml } from '../../shared/utils/dom';
import type { Translator } from '../i18n';
import { hasRole } from '../api/ConsoleApiClient';
import { attributeLabel, displayValue } from '../format';
import type { EntityDescriptor, Entry, SchemaAttribute } from '../types';

/** Characters required before a search is issued. */
export const SEARCH_MINIMUM = 3;

const PAGE_SIZES = [25, 50, 100, 200];
const PAGE_SIZE_KEY = 'ldap-rest.console.pageSize';

export interface ListOptions {
  entity: EntityDescriptor;
  translator: Translator;
  /** Fetch the entries; `search` is already known to be long enough */
  load(search: string, attribute: string): Promise<Record<string, Entry>>;
  /** Whether the branch is small enough to show without a search */
  listable: boolean;
  onOpen(id: string): void;
  onDelete(ids: string[]): Promise<void>;
  canDelete: boolean;
}

/**
 * One value as a CSV cell.
 *
 * Two separate jobs. RFC 4180 quoting is what keeps a comma or a newline
 * inside its own field; the leading apostrophe is what keeps a spreadsheet
 * from *evaluating* the cell. A directory holds whatever was written into it,
 * and Excel and LibreOffice both read a value opening on `= + - @` — or on a
 * tab or a carriage return — as a formula rather than as text. Quoting does
 * not help there: the quotes are stripped on import and the formula runs.
 *
 * @param value value to write
 * @returns the cell, escaped and neutralised
 */
export function csvCell(value: string): string {
  const cell = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Read an entry value as a display string. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** Remembered page size, or the first sensible default. */
function storedPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if (PAGE_SIZES.includes(stored)) return stored;
    // eslint-disable-next-line no-empty
  } catch {}
  return PAGE_SIZES[0];
}

export class EntityList {
  private readonly options: ListOptions;
  private readonly columns: string[];
  private root: HTMLElement | null = null;
  private entries: [string, Entry][] = [];
  private selected = new Set<string>();
  private search = '';
  private searchAttribute: string;
  private page = 0;
  private pageSize = storedPageSize();
  private loading = false;
  private loaded = false;
  private error: string | null = null;
  /** Set when the reader asked for the whole branch despite the guard */
  private listEverything = false;
  /**
   * Which load is the current one. A search is debounced, not serialised, so
   * two requests are in flight whenever the operator keeps typing — and the
   * one that answers last is not the one that was asked last. Every load
   * takes a ticket and drops its answer if another was issued meanwhile.
   */
  private generation = 0;

  constructor(options: ListOptions) {
    this.options = options;
    this.columns = EntityList.chooseColumns(options.entity);
    this.searchAttribute = options.entity.mainAttribute;
  }

  /**
   * Columns worth showing: the identifier first, then the attributes whose
   * role makes them the ones an administrator scans a list for — a name, an
   * address, the organization an entry belongs to.
   *
   * @param entity entity being listed
   * @returns attribute names, in display order
   */
  static chooseColumns(entity: EntityDescriptor): string[] {
    const attributes = entity.schema.attributes;
    const wanted = [
      'employeeId',
      'displayName',
      'primaryEmail',
      'organizationPath',
      'writePolicy',
      'accountStatus',
    ];
    const columns = [entity.mainAttribute];
    for (const role of wanted) {
      for (const [name, attr] of Object.entries(attributes)) {
        if (columns.includes(name)) continue;
        if (hasRole(attr, role)) columns.push(name);
      }
    }
    // A schema that declares no role at all still deserves a usable table.
    if (columns.length === 1) {
      for (const [name, attr] of Object.entries(attributes)) {
        if (columns.length >= 5) break;
        if (name === 'objectClass' || attr.type === 'array') continue;
        if (!columns.includes(name)) columns.push(name);
      }
    }
    return columns;
  }

  /** Attributes a search can be run against: the visible, single-valued ones. */
  private searchableAttributes(): [string, SchemaAttribute][] {
    return Object.entries(this.options.entity.schema.attributes).filter(
      ([name, attr]) =>
        name !== 'objectClass' &&
        !attr.neverReturn &&
        attr.type !== 'array' &&
        attr.type !== 'pointer'
    );
  }

  /**
   * Render into a container and load what can be loaded.
   *
   * @param container element to fill
   */
  async render(container: HTMLElement): Promise<void> {
    this.root = container;
    this.draw();
    if (this.listable() && !this.loaded) await this.reload();
  }

  /** Whether the branch may be shown without a search. */
  private listable(): boolean {
    return this.options.listable || this.listEverything;
  }

  /** Fetch the entries matching the current search. */
  private async reload(): Promise<void> {
    const generation = ++this.generation;
    if (!this.listable() && this.search.length < SEARCH_MINIMUM) {
      this.entries = [];
      this.loaded = false;
      this.draw();
      return;
    }
    this.loading = true;
    this.error = null;
    this.draw();
    try {
      const list = await this.options.load(this.search, this.searchAttribute);
      if (generation !== this.generation) return;
      this.entries = Object.entries(list).sort(([a], [b]) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      );
      this.loaded = true;
      this.page = 0;
      this.selected.clear();
    } catch (err) {
      if (generation !== this.generation) return;
      this.error = (err as Error).message;
      this.entries = [];
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.draw();
      }
    }
  }

  /** Repaint the whole table. */
  private draw(): void {
    const root = this.root;
    if (!root) return;
    const { translator } = this.options;

    const total = this.entries.length;
    const from = this.page * this.pageSize;
    const slice = this.entries.slice(from, from + this.pageSize);

    root.innerHTML = `
      <div class="dc-list">
        <div class="dc-list-toolbar">
          <div class="dc-search">
            <input type="search" class="dc-input" data-search
              value="${escapeHtml(this.search)}"
              placeholder="${escapeHtml(translator.t('list.search'))}" />
            <label class="dc-search-scope">
              <span>${escapeHtml(translator.t('list.searchIn'))}</span>
              <select class="dc-input" data-search-attribute>
                ${this.searchableAttributes()
                  .map(
                    ([name, attr]) =>
                      `<option value="${escapeHtml(name)}"${
                        name === this.searchAttribute ? ' selected' : ''
                      }>${escapeHtml(
                        attributeLabel(
                          name,
                          attr,
                          this.options.translator.language
                        )
                      )}</option>`
                  )
                  .join('')}
              </select>
            </label>
          </div>
          <div class="dc-bulk" ${this.selected.size ? '' : 'hidden'}>
            <span>${escapeHtml(
              translator.t('list.selected', { count: this.selected.size })
            )}</span>
            <button type="button" class="dc-button" data-export>${escapeHtml(
              translator.t('list.export')
            )}</button>
            ${
              this.options.canDelete
                ? `<button type="button" class="dc-button dc-button-danger" data-delete-selected>${escapeHtml(
                    translator.t('list.deleteSelected')
                  )}</button>`
                : ''
            }
          </div>
        </div>
        ${this.bodyMarkup(slice)}
        ${this.footerMarkup(total, from, slice.length)}
      </div>`;

    this.bind();
  }

  private bodyMarkup(slice: [string, Entry][]): string {
    const { translator } = this.options;
    if (this.loading)
      return `<p class="dc-empty">${escapeHtml(translator.t('app.loading'))}</p>`;
    if (this.error)
      return `<p class="dc-empty dc-error-block">${escapeHtml(this.error)}</p>`;
    if (!this.listable() && this.search.length < SEARCH_MINIMUM)
      return `<p class="dc-empty">${escapeHtml(
        translator.t('list.searchGuard', { count: SEARCH_MINIMUM })
      )}<br /><button type="button" class="dc-button" data-list-all>${escapeHtml(
        translator.t('list.listEverything')
      )}</button></p>`;
    if (this.entries.length === 0)
      return `<p class="dc-empty">${escapeHtml(
        translator.t(this.search ? 'list.noMatch' : 'list.empty')
      )}</p>`;

    const attributes = this.options.entity.schema.attributes;
    return `
      <div class="dc-table-scroll">
        <table class="dc-table">
          <thead>
            <tr>
              <th class="dc-checkbox-cell">
                <input type="checkbox" data-select-all
                  aria-label="${escapeHtml(translator.t('list.selectAll'))}" />
              </th>
              ${this.columns
                .map(
                  name =>
                    `<th>${escapeHtml(
                      attributeLabel(
                        name,
                        attributes[name],
                        translator.language
                      )
                    )}</th>`
                )
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${slice.map(([id, entry]) => this.rowMarkup(id, entry)).join('')}
          </tbody>
        </table>
      </div>`;
  }

  private rowMarkup(id: string, entry: Entry): string {
    const { translator, entity } = this.options;
    return `
      <tr data-id="${escapeHtml(id)}">
        <td class="dc-checkbox-cell">
          <input type="checkbox" data-select="${escapeHtml(id)}"
            ${this.selected.has(id) ? 'checked' : ''}
            aria-label="${escapeHtml(translator.t('list.selectRow'))}" />
        </td>
        ${this.columns
          .map(name => {
            const attr = entity.schema.attributes[name];
            const raw = text(entry[name]);
            const shown = text(
              (Array.isArray(entry[name]) ? entry[name] : [entry[name]])
                .filter((v): v is string => v !== undefined)
                .map(v => displayValue(attr, String(v)))
            );
            const isPath = name === entity.organizationPath;
            return `<td${isPath ? ' class="dc-path"' : ''} title="${escapeHtml(raw)}">${
              isPath ? EntityList.shortenPath(shown) : escapeHtml(shown)
            }</td>`;
          })
          .join('')}
      </tr>`;
  }

  /**
   * A deep organization path fills a column and tells the reader nothing. Keep
   * the root and the leaf, which is what identifies it, and leave the whole
   * path in the cell's title.
   *
   * @param path full path
   * @returns the shortened, escaped form
   */
  static shortenPath(path: string): string {
    const segments = path.split(/\s*\/\s*/).filter(Boolean);
    if (segments.length <= 2) return escapeHtml(path);
    return `${escapeHtml(segments[0])} / … / ${escapeHtml(
      segments[segments.length - 1]
    )}`;
  }

  private footerMarkup(total: number, from: number, shown: number): string {
    if (total === 0) return '';
    const { translator } = this.options;
    const pages = Math.ceil(total / this.pageSize);
    return `
      <div class="dc-list-footer">
        <label class="dc-page-size">
          <span>${escapeHtml(translator.t('list.perPage'))}</span>
          <select class="dc-input" data-page-size>
            ${PAGE_SIZES.map(
              size =>
                `<option value="${size}"${size === this.pageSize ? ' selected' : ''}>${size}</option>`
            ).join('')}
          </select>
        </label>
        <span class="dc-count">${escapeHtml(
          translator.t('list.count', {
            from: from + 1,
            to: from + shown,
            total,
          })
        )}</span>
        <div class="dc-pager">
          <button type="button" class="dc-button" data-page="-1" ${
            this.page === 0 ? 'disabled' : ''
          }>${escapeHtml(translator.t('list.previous'))}</button>
          <button type="button" class="dc-button" data-page="1" ${
            this.page >= pages - 1 ? 'disabled' : ''
          }>${escapeHtml(translator.t('list.next'))}</button>
        </div>
      </div>`;
  }

  private bind(): void {
    const root = this.root;
    if (!root) return;

    const search = root.querySelector<HTMLInputElement>('[data-search]');
    let timer: ReturnType<typeof setTimeout> | undefined;
    search?.addEventListener('input', () => {
      this.search = search.value.trim();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.reload(), 250);
    });

    root
      .querySelector<HTMLSelectElement>('[data-search-attribute]')
      ?.addEventListener('change', event => {
        this.searchAttribute = (event.target as HTMLSelectElement).value;
        void this.reload();
      });

    root
      .querySelector<HTMLSelectElement>('[data-page-size]')
      ?.addEventListener('change', event => {
        this.pageSize = Number((event.target as HTMLSelectElement).value);
        this.page = 0;
        try {
          localStorage.setItem(PAGE_SIZE_KEY, String(this.pageSize));
          // eslint-disable-next-line no-empty
        } catch {}
        this.draw();
      });

    for (const button of Array.from(
      root.querySelectorAll<HTMLElement>('[data-page]')
    )) {
      button.addEventListener('click', () => {
        this.page += Number(button.dataset.page);
        this.draw();
      });
    }

    root
      .querySelector<HTMLInputElement>('[data-select-all]')
      ?.addEventListener('change', event => {
        const checked = (event.target as HTMLInputElement).checked;
        for (const box of Array.from(
          root.querySelectorAll<HTMLInputElement>('[data-select]')
        )) {
          const id = box.dataset.select as string;
          if (checked) this.selected.add(id);
          else this.selected.delete(id);
        }
        this.draw();
      });

    for (const box of Array.from(
      root.querySelectorAll<HTMLInputElement>('[data-select]')
    )) {
      box.addEventListener('change', () => {
        const id = box.dataset.select as string;
        if (box.checked) this.selected.add(id);
        else this.selected.delete(id);
        this.draw();
      });
    }

    for (const row of Array.from(
      root.querySelectorAll<HTMLElement>('tbody tr')
    )) {
      row.addEventListener('click', event => {
        if ((event.target as HTMLElement).closest('.dc-checkbox-cell')) return;
        this.options.onOpen(row.dataset.id as string);
      });
    }

    root.querySelector('[data-list-all]')?.addEventListener('click', () => {
      this.listEverything = true;
      void this.reload();
    });

    root.querySelector('[data-export]')?.addEventListener('click', () => {
      this.exportSelection();
    });

    root
      .querySelector('[data-delete-selected]')
      ?.addEventListener('click', () => {
        void this.options
          .onDelete([...this.selected])
          .then(() => this.reload());
      });
  }

  /** Hand the selection to the browser as a CSV file. */
  private exportSelection(): void {
    const rows = this.entries.filter(([id]) => this.selected.has(id));
    const header = this.columns.join(',');
    const body = rows
      .map(([, entry]) =>
        this.columns.map(name => csvCell(text(entry[name]))).join(',')
      )
      .join('\n');
    const blob = new Blob([`${header}\n${body}\n`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.options.entity.pluralName}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Reload after a change made elsewhere. */
  async refresh(): Promise<void> {
    await this.reload();
  }
}
