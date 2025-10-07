/**
 * LDAP User Editor - Organization Tree Component
 * Shows only LDAP organization tree (filters out users/groups)
 */

import type { LdapUser } from '../types';

export class UserTree {
  private container: HTMLElement;
  private baseUrl: string;
  private onSelectOrg: (dn: string) => void;
  private expandedNodes: Set<string> = new Set();
  private selectedDn: string | null = null;
  private rootDn: string | null = null;

  constructor(
    container: HTMLElement,
    baseUrl: string,
    onSelectOrg: (dn: string) => void
  ) {
    this.container = container;
    this.baseUrl = baseUrl;
    this.onSelectOrg = onSelectOrg;
  }

  async init(): Promise<void> {
    this.container.innerHTML = `
      <div class="sidebar">
        <div class="sidebar-header">
          <h2>
            <span class="material-icons">account_tree</span>
            Organizations
          </h2>
        </div>
        <div id="org-tree-viewer" class="user-tree">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    `;

    try {
      // Load top organization
      const res = await fetch(`${this.baseUrl}/api/v1/ldap/organizations/top`);
      if (!res.ok) throw new Error('Failed to load top organization');
      const topOrg = await res.json();
      this.rootDn = topOrg.dn;
      await this.renderTree();
    } catch (error) {
      console.error('Failed to init tree:', error);
      const treeEl = this.container.querySelector('#org-tree-viewer');
      if (treeEl) {
        treeEl.innerHTML =
          '<div class="empty-state"><span class="material-icons">error</span><p>Failed to load organization tree</p></div>';
      }
    }
  }

  private async renderTree(): Promise<void> {
    const treeEl = this.container.querySelector('#org-tree-viewer');
    if (!treeEl || !this.rootDn) return;

    try {
      const html = await this.renderNode(this.rootDn, 0);
      treeEl.innerHTML = html;
      this.attachEventListeners();
    } catch (error) {
      console.error('Failed to render tree:', error);
      treeEl.innerHTML =
        '<div class="empty-state"><span class="material-icons">error</span><p>Error rendering tree</p></div>';
    }
  }

  private async renderNode(dn: string, level: number): Promise<string> {
    const isExpanded = this.expandedNodes.has(dn);
    const isSelected = this.selectedDn === dn;
    const indent = level * 20;

    // Get node info
    const res = await fetch(
      `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
    );
    if (!res.ok) throw new Error('Failed to load organization');
    const node = await res.json();

    // Extract display name - handle both string and array
    let displayName = dn;
    if (node.ou) {
      displayName = Array.isArray(node.ou) ? node.ou[0] : node.ou;
    } else if (node.cn) {
      displayName = Array.isArray(node.cn) ? node.cn[0] : node.cn;
    }

    let html = `
      <div class="tree-node ${isSelected ? 'active' : ''}" style="padding-left: ${indent}px">
        <span class="material-icons tree-node-toggle" data-dn="${dn}">
          ${isExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span class="material-icons">business</span>
        <span class="tree-node-label" data-dn="${dn}">${displayName}</span>
      </div>
    `;

    if (isExpanded) {
      try {
        // Load subnodes and filter only organizations
        const subRes = await fetch(
          `${this.baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes`
        );
        if (subRes.ok) {
          const subnodes = await subRes.json();
          const orgs = subnodes.filter((n: LdapUser) => {
            const classes = Array.isArray(n.objectClass)
              ? n.objectClass
              : n.objectClass
                ? [n.objectClass]
                : [];
            return (
              classes.includes('organizationalUnit') ||
              classes.includes('organization')
            );
          });

          for (const subnode of orgs) {
            html += await this.renderNode(subnode.dn, level + 1);
          }
        }
      } catch (error) {
        console.error('Failed to load subnodes for', dn, error);
      }
    }

    return html;
  }

  private attachEventListeners(): void {
    // Toggle expand/collapse
    this.container.querySelectorAll('.tree-node-toggle').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const dn = el.getAttribute('data-dn');
        if (!dn) return;

        if (this.expandedNodes.has(dn)) {
          this.expandedNodes.delete(dn);
        } else {
          this.expandedNodes.add(dn);
        }
        await this.renderTree();
      });
    });

    // Select organization
    this.container.querySelectorAll('.tree-node-label').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const dn = el.getAttribute('data-dn');
        if (!dn) return;

        this.selectedDn = dn;
        this.renderTree();
        this.onSelectOrg(dn);
      });
    });
  }

  async refresh(): Promise<void> {
    await this.renderTree();
  }

  destroy(): void {
    this.container.innerHTML = '';
  }
}
