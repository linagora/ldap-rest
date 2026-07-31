/**
 * Lazy directory tree: one root per exposed base, children fetched on expand.
 * @module browser/ldap-browser/components/EntryTree
 */

import { DisposableComponent } from '../../shared/components/DisposableComponent';
import { escapeHtml } from '../../shared/utils/dom';
import type { RawApiClient } from '../api/RawApiClient';
import type { RawChildren } from '../types';

/** Icon picked from the object classes of an entry */
function iconFor(objectClass: string[]): string {
  const classes = objectClass.map(c => c.toLowerCase());
  if (
    classes.includes('organizationalunit') ||
    classes.includes('organization')
  )
    return 'folder';
  if (
    classes.includes('groupofnames') ||
    classes.includes('groupofuniquenames') ||
    classes.includes('posixgroup')
  )
    return 'group';
  if (
    classes.includes('inetorgperson') ||
    classes.includes('person') ||
    classes.includes('organizationalperson')
  )
    return 'person';
  if (classes.includes('domain') || classes.includes('dcobject')) return 'dns';
  return 'article';
}

export class EntryTree extends DisposableComponent {
  private container: HTMLElement;
  private api: RawApiClient;
  private onSelect: (dn: string) => void | Promise<void>;
  private onError: (error: Error) => void;

  private roots: string[] = [];
  private children = new Map<string, RawChildren>();
  private expanded = new Set<string>();
  private loading = new Set<string>();
  private selectedDn: string | null = null;

  constructor(
    container: HTMLElement,
    api: RawApiClient,
    onSelect: (dn: string) => void | Promise<void>,
    onError: (error: Error) => void
  ) {
    super();
    this.container = container;
    this.api = api;
    this.onSelect = onSelect;
    this.onError = onError;

    this.addManagedEventListener(this.container, 'click', event => {
      const target = (event.target as HTMLElement).closest(
        '[data-dn]'
      ) as HTMLElement | null;
      if (!target) return;
      const dn = target.dataset.dn as string;
      if (target.classList.contains('ldap-browser-tree__toggle')) {
        void this.toggle(dn);
      } else {
        void this.select(dn);
      }
    });
  }

  /**
   * Load the exposed bases and draw them as roots.
   *
   * @param bases base DNs to use as roots
   */
  async init(bases: string[]): Promise<void> {
    this.roots = bases;
    // Open the first root so the tree is never empty on arrival
    if (bases.length > 0) await this.expand(bases[0]);
    this.render();
  }

  /**
   * DN currently highlighted in the tree.
   *
   * @returns selected DN, or null
   */
  getSelectedDn(): string | null {
    return this.selectedDn;
  }

  /**
   * Highlight an entry and notify the parent component.
   *
   * @param dn DN to select
   * @returns whatever the selection handler returns, so callers can await
   *          the entry actually being displayed
   */
  select(dn: string): void | Promise<void> {
    this.selectedDn = dn;
    this.render();
    return this.onSelect(dn);
  }

  /**
   * Expand the tree down to a DN, loading every level on the way, then
   * select it. Used to follow a search result or a DN typed by the user.
   *
   * @param dn DN to reveal
   */
  async revealAndSelect(dn: string): Promise<void> {
    const root = this.roots.find(
      base =>
        dn.toLowerCase() === base.toLowerCase() ||
        dn.toLowerCase().endsWith(`,${base.toLowerCase()}`)
    );
    if (root) {
      // Walk down from the root, expanding each ancestor
      const relative = dn
        .substring(0, dn.length - root.length)
        .replace(/,$/, '');
      const rdns = relative ? splitDn(relative) : [];
      let current = root;
      await this.expand(current);
      // Expand the ancestors only: the target itself stays closed
      for (let i = rdns.length - 1; i >= 1; i--) {
        current = `${rdns[i]},${current}`;
        await this.expand(current);
      }
    }
    await this.select(dn);
  }

  /**
   * Drop cached children so the next expand hits the server again.
   *
   * @param dn DN whose children must be reloaded, or undefined for all
   */
  invalidate(dn?: string): void {
    if (dn) this.children.delete(dn);
    else this.children.clear();
  }

  /**
   * Expand a node, fetching its children the first time.
   *
   * @param dn DN of the node
   */
  private async expand(dn: string): Promise<void> {
    this.expanded.add(dn);
    if (this.children.has(dn)) return;
    this.loading.add(dn);
    this.render();
    try {
      this.children.set(dn, await this.api.getChildren(dn));
    } catch (err) {
      this.expanded.delete(dn);
      this.onError(err as Error);
    } finally {
      this.loading.delete(dn);
      this.render();
    }
  }

  /**
   * Expand or collapse a node.
   *
   * @param dn DN of the node
   */
  private async toggle(dn: string): Promise<void> {
    if (this.expanded.has(dn)) {
      this.expanded.delete(dn);
      this.render();
      return;
    }
    await this.expand(dn);
  }

  /** Redraw the whole tree */
  private render(): void {
    if (this.isDestroyed) return;
    this.container.innerHTML = `<ul class="ldap-browser-tree">${this.roots
      .map(root => this.renderNode(root, root, ['dcObject'], true))
      .join('')}</ul>`;
  }

  /**
   * Render one node and, when expanded, its children.
   *
   * @param dn DN of the node
   * @param label text shown for the node
   * @param objectClass object classes, used to pick the icon
   * @param expandable whether the node may have children
   * @returns HTML of the node
   */
  private renderNode(
    dn: string,
    label: string,
    objectClass: string[],
    expandable: boolean
  ): string {
    const isExpanded = this.expanded.has(dn);
    const isLoading = this.loading.has(dn);
    const isSelected = this.selectedDn === dn;
    const children = this.children.get(dn);

    const toggle = expandable
      ? `<span class="ldap-browser-tree__toggle material-icons" data-dn="${escapeHtml(dn)}">${
          isLoading
            ? 'hourglass_empty'
            : isExpanded
              ? 'expand_more'
              : 'chevron_right'
        }</span>`
      : '<span class="ldap-browser-tree__toggle ldap-browser-tree__toggle--leaf"></span>';

    const sub =
      isExpanded && children
        ? `<ul>${
            children.children.length === 0
              ? '<li class="ldap-browser-tree__empty">(no child)</li>'
              : children.children
                  .map(child =>
                    this.renderNode(
                      child.dn,
                      child.rdn,
                      child.objectClass,
                      child.hasChildren
                    )
                  )
                  .join('')
          }${
            children.truncated
              ? `<li class="ldap-browser-tree__truncated" title="Raise --ldap-raw-max-results to see more">
                   first ${children.children.length} entries only — use the search to find the others
                 </li>`
              : ''
          }</ul>`
        : '';

    return `<li>
      <div class="ldap-browser-tree__node${isSelected ? ' ldap-browser-tree__node--selected' : ''}">
        ${toggle}
        <span class="ldap-browser-tree__label" data-dn="${escapeHtml(dn)}" title="${escapeHtml(dn)}">
          <span class="material-icons">${iconFor(objectClass)}</span>
          <span class="ldap-browser-tree__name">${escapeHtml(label)}</span>
        </span>
      </div>
      ${sub}
    </li>`;
  }
}

/**
 * Split a DN into its components, honouring `\,` escapes.
 *
 * @param dn DN to split
 * @returns RDN components, outermost first
 */
function splitDn(dn: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < dn.length; i++) {
    if (dn[i] === '\\' && i + 1 < dn.length) {
      current += dn[i] + dn[i + 1];
      i++;
    } else if (dn[i] === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += dn[i];
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
