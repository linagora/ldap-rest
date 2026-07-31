/**
 * Low-level LDAP browser: a tree of the directory on the left, the raw
 * content of the selected entry on the right, and a filter search on top.
 *
 * Read-only: it renders what the `core/ldap/raw` plugin serves.
 *
 * @module browser/ldap-browser/LdapBrowser
 */

import { escapeHtml } from '../shared/utils/dom';

import { RawApiClient } from './api/RawApiClient';
import { EntryTree } from './components/EntryTree';
import { EntryView } from './components/EntryView';
import { SchemaView } from './schema';
import type { BrowserOptions, RawSearchResult } from './types';

export class LdapBrowser {
  private options: BrowserOptions;
  private api: RawApiClient;
  private container: HTMLElement | null = null;
  private tree: EntryTree | null = null;
  private entryView: EntryView | null = null;
  private schema: SchemaView | null = null;
  private bases: string[] = [];
  private currentDn: string | null = null;

  constructor(options: BrowserOptions) {
    this.options = options;
    this.api = new RawApiClient(options.apiBaseUrl || '', options.authToken);
  }

  /**
   * Build the interface, load the schema and open the first base.
   *
   * @throws Error when the container does not exist or the API is unreachable
   */
  async init(): Promise<void> {
    const container = document.getElementById(this.options.containerId);
    if (!container)
      throw new Error(
        `Container element with id '${this.options.containerId}' not found`
      );
    this.container = container;

    this.bases = await this.api.getBases();
    this.render();

    // The schema only decorates the display: a directory that refuses it
    // must not prevent browsing
    try {
      this.schema = new SchemaView(await this.api.getSchema());
    } catch (err) {
      this.reportError(err as Error);
    }

    const treeContainer = container.querySelector<HTMLElement>(
      '.ldap-browser__tree'
    );
    const entryContainer = container.querySelector<HTMLElement>(
      '.ldap-browser__entry'
    );
    if (!treeContainer || !entryContainer) return;

    this.entryView = new EntryView(entryContainer, this.schema);
    this.entryView.renderEmpty();

    this.tree = new EntryTree(
      treeContainer,
      this.api,
      dn => this.showEntry(dn),
      error => this.reportError(error)
    );
    await this.tree.init(this.bases);

    this.bindToolbar();

    const initial = this.options.initialDn || this.bases[0];
    if (initial) await this.tree.revealAndSelect(initial);
  }

  /** Release the listeners held by the tree */
  destroy(): void {
    this.tree?.destroy();
    this.tree = null;
  }

  /**
   * DN currently displayed.
   *
   * @returns selected DN, or null when none
   */
  getCurrentDn(): string | null {
    return this.currentDn;
  }

  /** Draw the static layout */
  private render(): void {
    if (!this.container) return;
    this.container.classList.add('ldap-browser-container');
    this.container.innerHTML = `
      <div class="ldap-browser">
        <div class="ldap-browser__toolbar">
          <input class="ldap-browser__filter" type="text"
                 placeholder="LDAP filter, e.g. (uid=alice)" />
          <select class="ldap-browser__scope">
            <option value="sub">sub</option>
            <option value="one">one</option>
            <option value="base">base</option>
          </select>
          <select class="ldap-browser__base">
            ${this.bases
              .map(
                base =>
                  `<option value="${escapeHtml(base)}">${escapeHtml(base)}</option>`
              )
              .join('')}
          </select>
          <button class="ldap-browser__search" type="button">
            <span class="material-icons">search</span> Search
          </button>
          <button class="ldap-browser__refresh" type="button" title="Reload">
            <span class="material-icons">refresh</span>
          </button>
        </div>
        <div class="ldap-browser__body">
          <div class="ldap-browser__tree"></div>
          <div class="ldap-browser__entry"></div>
        </div>
        <div class="ldap-browser__results" hidden></div>
      </div>`;
  }

  /** Wire the search and refresh controls */
  private bindToolbar(): void {
    const filter = this.container?.querySelector<HTMLInputElement>(
      '.ldap-browser__filter'
    );
    const searchButton = this.container?.querySelector<HTMLButtonElement>(
      '.ldap-browser__search'
    );
    const refreshButton = this.container?.querySelector<HTMLButtonElement>(
      '.ldap-browser__refresh'
    );
    const results = this.container?.querySelector<HTMLElement>(
      '.ldap-browser__results'
    );

    searchButton?.addEventListener('click', () => void this.runSearch());
    filter?.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Enter') void this.runSearch();
    });
    refreshButton?.addEventListener('click', () => {
      this.tree?.invalidate();
      if (this.currentDn) void this.showEntry(this.currentDn);
    });
    results?.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest(
        '[data-dn]'
      ) as HTMLElement | null;
      if (target?.dataset.dn)
        void this.tree?.revealAndSelect(target.dataset.dn);
    });
  }

  /**
   * Load an entry and display it.
   *
   * @param dn DN of the entry
   */
  private async showEntry(dn: string): Promise<void> {
    if (!this.entryView) return;
    this.currentDn = dn;
    this.entryView.renderLoading();
    try {
      const entry = await this.api.getEntry(dn);
      this.entryView.render(entry);
      this.options.onEntrySelected?.(dn);
    } catch (err) {
      this.entryView.renderError((err as Error).message);
      this.reportError(err as Error);
    }
  }

  /** Run the search typed in the toolbar and list the matching DNs */
  private async runSearch(): Promise<void> {
    const filter =
      this.container?.querySelector<HTMLInputElement>('.ldap-browser__filter')
        ?.value || '';
    const scope =
      this.container?.querySelector<HTMLSelectElement>('.ldap-browser__scope')
        ?.value || 'sub';
    const base =
      this.container?.querySelector<HTMLSelectElement>('.ldap-browser__base')
        ?.value || this.bases[0];
    const results = this.container?.querySelector<HTMLElement>(
      '.ldap-browser__results'
    );
    if (!results) return;

    if (!filter.trim()) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }

    results.hidden = false;
    results.innerHTML = '<p>Searching…</p>';
    try {
      const found: RawSearchResult = await this.api.search({
        base,
        scope: scope as 'base' | 'one' | 'sub',
        filter,
        attributes: ['dn'],
      });
      results.innerHTML = found.entries.length
        ? `<p>${found.entries.length} result(s)${
            found.truncated ? ' (truncated)' : ''
          }</p>
           <ul>${found.entries
             .map(
               entry =>
                 `<li><a href="#" data-dn="${escapeHtml(entry.dn)}">${escapeHtml(
                   entry.dn
                 )}</a></li>`
             )
             .join('')}</ul>`
        : '<p>No result</p>';
    } catch (err) {
      results.innerHTML = `<p class="ldap-browser__error">${escapeHtml(
        (err as Error).message
      )}</p>`;
      this.reportError(err as Error);
    }
  }

  /**
   * Forward an error to the host page, or log it when no handler was given.
   *
   * @param error error to report
   */
  private reportError(error: Error): void {
    if (this.options.onError) this.options.onError(error);
    else console.error('[ldap-browser]', error);
  }
}
