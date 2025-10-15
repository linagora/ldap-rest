/**
 * Move Group Modal Component - Modal for selecting target organization when moving a group
 */

import type { GroupApiClient } from '../api/GroupApiClient';

export class MoveGroupModal {
  private api: GroupApiClient;
  private currentOrgDn: string;
  private onMove: (targetOrgDn: string) => Promise<void>;
  private modal: HTMLElement | null = null;
  private expandedNodes = new Set<string>();
  private selectedOrgDn: string | null = null;

  constructor(
    api: GroupApiClient,
    currentOrgDn: string,
    onMove: (targetOrgDn: string) => Promise<void>
  ) {
    this.api = api;
    this.currentOrgDn = currentOrgDn;
    this.onMove = onMove;
  }

  async show(): Promise<void> {
    // Create modal backdrop
    this.modal = document.createElement('div');
    this.modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `;

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 24px;
      max-width: 600px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    `;

    modalContent.innerHTML = `
      <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
        <span class="material-icons">drive_file_move</span>
        Move Group to Organization
      </h3>
      <p style="margin: 0 0 16px 0; color: #666;">Select the target organization:</p>
      <div id="org-tree" style="margin-bottom: 24px; max-height: 400px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; padding: 12px;">
        <div class="loading"><div class="spinner"></div></div>
      </div>
      <div style="display: flex; gap: 12px; justify-content: flex-end;">
        <button type="button" id="cancel-move-btn" style="padding: 10px 20px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer;">Cancel</button>
        <button type="button" id="confirm-move-btn" disabled style="padding: 10px 20px; background: var(--primary-color, #6200ee); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
          <span class="material-icons" style="font-size: 18px;">drive_file_move</span>
          Move Here
        </button>
      </div>
    `;

    this.modal.appendChild(modalContent);
    document.body.appendChild(this.modal);

    // Attach event listeners
    const cancelBtn = this.modal.querySelector('#cancel-move-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.close());
    }

    const confirmBtn = this.modal.querySelector('#confirm-move-btn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => this.handleConfirm());
    }

    // Click outside to close
    this.modal.addEventListener('click', e => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    // Load organization tree
    await this.loadOrgTree();
  }

  private async loadOrgTree(): Promise<void> {
    const treeContainer = this.modal?.querySelector('#org-tree');
    if (!treeContainer) return;

    try {
      // Get top organization
      const response = await fetch(
        `${this.api['baseUrl']}/api/v1/ldap/organizations/top`
      );
      if (!response.ok) throw new Error('Failed to load organizations');

      const topOrg = await response.json();
      const rootDn = topOrg.dn;

      // Render tree starting from root
      const html = await this.renderNode(rootDn, 0);
      treeContainer.innerHTML = html;
      this.attachTreeEventListeners();
    } catch (error) {
      console.error('Failed to load organization tree:', error);
      treeContainer.innerHTML = `<p style="color: #f44336;">Failed to load organizations</p>`;
    }
  }

  private async renderNode(dn: string, level: number): Promise<string> {
    const isExpanded = this.expandedNodes.has(dn);
    const isSelected = this.selectedOrgDn === dn;
    const isCurrent = this.currentOrgDn === dn;
    const indent = level * 20;

    // Get node info
    const response = await fetch(
      `${this.api['baseUrl']}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
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

    const nodeClass = `tree-node ${isSelected ? 'selected' : ''} ${isCurrent ? 'current-org' : ''}`;
    const nodeStyle = `padding-left: ${indent}px; padding: 8px 8px 8px ${indent}px; cursor: ${isCurrent ? 'not-allowed' : 'pointer'}; display: flex; align-items: center; gap: 4px; ${isCurrent ? 'opacity: 0.5; background: #f5f5f5;' : isSelected ? 'background: #e3f2fd;' : ''}`;

    let html = `
      <div class="${nodeClass}" style="${nodeStyle}" data-dn="${this.escapeHtml(dn)}" data-is-current="${isCurrent}">
        <span class="material-icons tree-node-toggle" data-dn="${this.escapeHtml(dn)}" style="font-size: 18px; cursor: pointer;">
          ${isExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span class="material-icons" style="font-size: 18px;">business</span>
        <span class="tree-node-label" data-dn="${this.escapeHtml(dn)}">${this.escapeHtml(displayName)}</span>
        ${isCurrent ? '<span style="font-size: 12px; color: #666; margin-left: 8px;">(current)</span>' : ''}
      </div>
    `;

    // If expanded, load and render subnodes
    if (isExpanded) {
      try {
        const subnodesResponse = await fetch(
          `${this.api['baseUrl']}/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes`
        );
        if (!subnodesResponse.ok) throw new Error('Failed to load subnodes');

        const subnodes = await subnodesResponse.json();
        const orgs = subnodes.filter((n: any) => {
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
      } catch (error) {
        console.error('Failed to load subnodes for', dn, error);
      }
    }

    return html;
  }

  private attachTreeEventListeners(): void {
    const treeContainer = this.modal?.querySelector('#org-tree');
    if (!treeContainer) return;

    // Toggle expand/collapse
    treeContainer.querySelectorAll('.tree-node-toggle').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const dn = el.getAttribute('data-dn');
        if (!dn) return;

        if (this.expandedNodes.has(dn)) {
          this.expandedNodes.delete(dn);
        } else {
          this.expandedNodes.add(dn);
        }
        await this.loadOrgTree();
      });
    });

    // Select organization
    treeContainer.querySelectorAll('.tree-node').forEach(el => {
      el.addEventListener('click', () => {
        const isCurrent = el.getAttribute('data-is-current') === 'true';
        if (isCurrent) return; // Cannot select current organization

        const dn = el.getAttribute('data-dn');
        if (!dn) return;

        this.selectedOrgDn = dn;

        // Update UI
        treeContainer.querySelectorAll('.tree-node').forEach(node => {
          node.classList.remove('selected');
          (node as HTMLElement).style.background = '';
        });
        el.classList.add('selected');
        (el as HTMLElement).style.background = '#e3f2fd';

        // Enable confirm button
        const confirmBtn = this.modal?.querySelector(
          '#confirm-move-btn'
        ) as HTMLButtonElement;
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.style.opacity = '1';
          confirmBtn.style.cursor = 'pointer';
        }
      });
    });
  }

  private async handleConfirm(): Promise<void> {
    if (!this.selectedOrgDn) return;

    try {
      await this.onMove(this.selectedOrgDn);
      this.close();
    } catch (error) {
      console.error('Failed to move group:', error);
      // Error will be shown by the parent component
    }
  }

  private close(): void {
    if (this.modal) {
      document.body.removeChild(this.modal);
      this.modal = null;
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
