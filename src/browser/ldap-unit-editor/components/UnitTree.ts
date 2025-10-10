/**
 * Unit Tree Component - Shows organizations tree (same as UserTree)
 */

export class UnitTree {
  private container: HTMLElement;
  private apiBaseUrl: string;
  private onOrgSelect: (orgDn: string) => void;
  private expandedNodes = new Set<string>();
  private selectedDn: string | null = null;
  private rootDn: string | null = null;

  constructor(
    container: HTMLElement,
    apiBaseUrl: string,
    onOrgSelect: (orgDn: string) => void
  ) {
    this.container = container;
    this.apiBaseUrl = apiBaseUrl;
    this.onOrgSelect = onOrgSelect;
  }

  async init(): Promise<void> {
    this.container.innerHTML = `
      <div class="unit-tree">
        <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
          <span class="material-icons">account_tree</span>
          Organizations
        </h3>
        <div id="tree-content">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    `;

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/v1/ldap/organizations/top`);
      if (!response.ok) throw new Error('Failed to load organizations');

      const topOrg = await response.json();
      this.rootDn = topOrg.dn;
      await this.renderTree();
    } catch (error) {
      console.error('Failed to init tree:', error);
      const treeEl = this.container.querySelector('#tree-content');
      if (treeEl) {
        treeEl.innerHTML = '<p style="color: #f44336;">Failed to load organizations</p>';
      }
    }
  }

  private async renderTree(): Promise<void> {
    const treeEl = this.container.querySelector('#tree-content');
    if (!treeEl || !this.rootDn) return;

    try {
      const html = await this.renderNode(this.rootDn, 0);
      treeEl.innerHTML = html;
      this.attachEventListeners();
    } catch (error) {
      console.error('Failed to render tree:', error);
      treeEl.innerHTML = '<p style="color: #f44336;">Error rendering tree</p>';
    }
  }

  private async renderNode(dn: string, level: number): Promise<string> {
    const isExpanded = this.expandedNodes.has(dn);
    const isSelected = this.selectedDn === dn;
    const indent = level * 20;

    // Get node info
    const response = await fetch(
      `${this.apiBaseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
    );
    if (!response.ok) throw new Error('Failed to load node');
    const node = await response.json();

    // Extract display name
    let displayName = dn;
    if (node.ou) {
      displayName = Array.isArray(node.ou) ? node.ou[0] : node.ou;
    } else if (node.cn) {
      displayName = Array.isArray(node.cn) ? node.cn[0] : node.cn;
    }

    let html = `
      <div class="tree-node ${isSelected ? 'active' : ''}" style="padding-left: ${indent}px; padding: 8px 8px 8px ${indent}px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
        <span class="material-icons tree-node-toggle" data-dn="${this.escapeHtml(dn)}" style="font-size: 18px; cursor: pointer;">
          ${isExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span class="material-icons" style="font-size: 18px;">business</span>
        <span class="tree-node-label" data-dn="${this.escapeHtml(dn)}">${this.escapeHtml(displayName)}</span>
      </div>
    `;

    if (isExpanded) {
      try {
        const subnodesResponse = await fetch(
          `${this.apiBaseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes`
        );
        if (!subnodesResponse.ok) throw new Error('Failed to load subnodes');

        const subnodes = await subnodesResponse.json();
        const orgs = subnodes.filter((n: any) => {
          const classes = Array.isArray(n.objectClass) ? n.objectClass : n.objectClass ? [n.objectClass] : [];
          return classes.includes('organizationalUnit') || classes.includes('organization');
        });

        for (const subnode of orgs) {
          html += await this.renderNode(subnode.dn, level + 1);
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
      el.addEventListener('click', async (e) => {
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
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const dn = el.getAttribute('data-dn');
        if (!dn) return;

        this.selectedDn = dn;
        this.onOrgSelect(dn);
        this.renderTree();
      });
    });
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
