/**
 * LDAP User Editor - Move User Modal Component
 * Modal dialog for selecting target organization when moving a user
 */

import type { UserApiClient } from '../api/UserApiClient';

export class MoveUserModal {
  private modal: HTMLElement | null = null;
  private api: UserApiClient;
  private currentOrgDn: string;
  private selectedOrgDn: string | null = null;
  private onMove: (targetOrgDn: string) => void;
  private expandedNodes: Set<string> = new Set();
  private rootDn: string | null = null;

  constructor(
    api: UserApiClient,
    currentOrgDn: string,
    onMove: (targetOrgDn: string) => void
  ) {
    this.api = api;
    this.currentOrgDn = currentOrgDn;
    this.onMove = onMove;
  }

  /**
   * Escape HTML special characters to prevent XSS attacks
   */
  private static escapeHtml(text: unknown): string {
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

  async show(): Promise<void> {
    // Create modal container
    this.modal = document.createElement('div');
    this.modal.className = 'modal-overlay active';
    this.modal.innerHTML = `
      <div class="modal-container" style="max-width: 600px;">
        <div class="modal-header">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
            <span class="material-icons">folder_open</span>
            Move User to Organization
          </h3>
          <button class="modal-close" id="modal-close-btn">
            <span class="material-icons">close</span>
          </button>
        </div>
        <div class="modal-body">
          <div id="move-modal-alert"></div>
          <div style="margin-bottom: 1rem; color: #666; font-size: 0.9rem;">
            Select the target organization where you want to move this user.
          </div>
          <div id="organization-tree-container" style="max-height: 400px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; padding: 0.5rem;">
            <div class="loading">
              <div class="spinner"></div>
              <p style="margin-top: 1rem">Loading organizations...</p>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="modal-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn btn-primary" id="modal-move-btn" disabled>
            <span class="material-icons">drive_file_move</span>
            Move User
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.modal);
    this.attachHandlers();
    await this.loadOrganizationTree();
  }

  private attachHandlers(): void {
    if (!this.modal) return;

    // Close button
    const closeBtn = this.modal.querySelector('#modal-close-btn');
    closeBtn?.addEventListener('click', () => this.close());

    // Cancel button
    const cancelBtn = this.modal.querySelector('#modal-cancel-btn');
    cancelBtn?.addEventListener('click', () => this.close());

    // Move button
    const moveBtn = this.modal.querySelector('#modal-move-btn');
    moveBtn?.addEventListener('click', () => this.handleMove());

    // Close on overlay click
    this.modal.addEventListener('click', e => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    // Close on Escape key
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  private async loadOrganizationTree(): Promise<void> {
    console.log('loadOrganizationTree called');
    const container = this.modal?.querySelector('#organization-tree-container');
    if (!container) {
      console.log('Container not found');
      return;
    }

    try {
      console.log('Fetching top organization...');
      // Get top organization
      const topOrg = await this.api['cachedFetch']<{ dn: string }>(
        `${this.api['baseUrl'] || window.location.origin}/api/v1/ldap/organizations/top`
      );
      console.log('Top org:', topOrg);
      this.rootDn = topOrg.dn;

      // Expand root by default
      this.expandedNodes.add(this.rootDn);

      console.log('Calling renderTree...');
      await this.renderTree();
      console.log('renderTree completed');
    } catch (error) {
      console.error('Error in loadOrganizationTree:', error);
      container.innerHTML = `
        <div class="alert alert-error">
          <span class="material-icons">error</span>
          <div>Failed to load organizations: ${MoveUserModal.escapeHtml((error as Error).message)}</div>
        </div>
      `;
    }
  }

  private async renderTree(): Promise<void> {
    console.log('renderTree called');
    const container = this.modal?.querySelector('#organization-tree-container');
    if (!container || !this.rootDn) {
      console.log('renderTree: no container or rootDn', {
        container,
        rootDn: this.rootDn,
      });
      return;
    }

    try {
      console.log('renderTree: calling renderNode for', this.rootDn);
      const html = await this.renderNode(this.rootDn, 0);
      console.log('renderTree: got html, length:', html.length);
      container.innerHTML = html;
      console.log('renderTree: html set, attaching handlers');
      this.attachTreeHandlers();
      console.log('renderTree: handlers attached');
    } catch (error) {
      console.error('Error in renderTree:', error);
      container.innerHTML = `
        <div class="alert alert-error">
          <span class="material-icons">error</span>
          <div>Error rendering tree: ${MoveUserModal.escapeHtml((error as Error).message)}</div>
        </div>
      `;
    }
  }

  private async renderNode(dn: string, level: number): Promise<string> {
    console.log('renderNode called for', dn, 'level', level);
    const isExpanded = this.expandedNodes.has(dn);
    const isCurrentOrg = dn === this.currentOrgDn;
    const isSelected = dn === this.selectedOrgDn;
    const indent = level * 20;

    // Get node info
    const baseUrl = this.api['baseUrl'] || window.location.origin;
    console.log(
      'Fetching node details from:',
      `${baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`
    );
    const node = await this.api['cachedFetch']<{
      dn: string;
      ou?: string | string[];
      twakeDepartmentPath?: string | string[];
    }>(`${baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}`);
    console.log('Got node:', node);

    // Extract display name
    const ou = Array.isArray(node.ou) ? node.ou[0] : node.ou;
    const path = node.twakeDepartmentPath
      ? Array.isArray(node.twakeDepartmentPath)
        ? node.twakeDepartmentPath[0]
        : node.twakeDepartmentPath
      : undefined;
    const displayName = path || ou || dn;

    let html = `
      <div
        class="org-node ${isCurrentOrg ? 'org-current' : ''} ${isSelected ? 'org-selected' : ''}"
        data-org-dn="${MoveUserModal.escapeHtml(dn)}"
        style="
          padding: 0.5rem;
          padding-left: ${indent + 8}px;
          cursor: ${isCurrentOrg ? 'not-allowed' : 'pointer'};
          background: ${isCurrentOrg ? '#f5f5f5' : isSelected ? '#e3f2fd' : 'white'};
          opacity: ${isCurrentOrg ? '0.6' : '1'};
          display: flex;
          align-items: center;
          gap: 0.5rem;
          border-left: 2px solid ${isSelected ? '#2196f3' : 'transparent'};
        "
      >
        <span class="material-icons tree-toggle" data-dn="${MoveUserModal.escapeHtml(dn)}" style="cursor: pointer; font-size: 1.2rem;">
          ${isExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span class="material-icons" style="font-size: 1.2rem; color: ${isCurrentOrg ? '#999' : '#2196f3'};">
          ${isCurrentOrg ? 'business' : 'folder'}
        </span>
        <span style="flex: 1; font-weight: ${isSelected ? '600' : '500'};">
          ${MoveUserModal.escapeHtml(displayName)}
          ${isCurrentOrg ? '<span style="font-size: 0.85rem; color: #666; margin-left: 0.5rem;">(current)</span>' : ''}
        </span>
        ${isSelected ? '<span class="material-icons" style="color: #2196f3;">check_circle</span>' : ''}
      </div>
    `;

    // If expanded, load and render subnodes
    if (isExpanded) {
      try {
        const subnodes = await this.api['cachedFetch']<
          Array<{ dn: string; objectClass?: string[] }>
        >(
          `${baseUrl}/api/v1/ldap/organizations/${encodeURIComponent(dn)}/subnodes?objectClass=organizationalUnit`
        );

        for (const subnode of subnodes) {
          html += await this.renderNode(subnode.dn, level + 1);
        }
      } catch {
        // No subnodes or error loading them
      }
    }

    return html;
  }

  private attachTreeHandlers(): void {
    // Handle tree toggle (expand/collapse)
    const toggles = this.modal?.querySelectorAll('.tree-toggle');
    toggles?.forEach(toggle => {
      toggle.addEventListener('click', async e => {
        e.stopPropagation();
        const dn = toggle.getAttribute('data-dn');
        if (!dn) return;

        if (this.expandedNodes.has(dn)) {
          this.expandedNodes.delete(dn);
        } else {
          this.expandedNodes.add(dn);
        }

        await this.renderTree();
      });
    });

    // Handle node selection
    const nodes = this.modal?.querySelectorAll('.org-node');
    nodes?.forEach(node => {
      const orgDn = node.getAttribute('data-org-dn');
      if (!orgDn || orgDn === this.currentOrgDn) return;

      node.addEventListener('click', () => {
        this.selectOrganization(orgDn);
      });
    });
  }

  private async selectOrganization(orgDn: string): Promise<void> {
    this.selectedOrgDn = orgDn;

    // Re-render tree to update selection state
    await this.renderTree();

    // Enable move button
    const moveBtn = this.modal?.querySelector(
      '#modal-move-btn'
    ) as HTMLButtonElement;
    if (moveBtn) {
      moveBtn.disabled = false;
    }
  }

  private async handleMove(): Promise<void> {
    if (!this.selectedOrgDn) return;

    const moveBtn = this.modal?.querySelector(
      '#modal-move-btn'
    ) as HTMLButtonElement;
    const alertContainer = this.modal?.querySelector('#move-modal-alert');

    if (moveBtn) {
      moveBtn.disabled = true;
      moveBtn.innerHTML = `
        <span class="spinner" style="width: 1rem; height: 1rem; border-width: 2px;"></span>
        Moving...
      `;
    }

    try {
      this.onMove(this.selectedOrgDn);
      this.close();
    } catch (error) {
      if (alertContainer) {
        alertContainer.innerHTML = `
          <div class="alert alert-error" style="margin-bottom: 1rem;">
            <span class="material-icons">error</span>
            <div>Move failed: ${MoveUserModal.escapeHtml((error as Error).message)}</div>
          </div>
        `;
      }

      if (moveBtn) {
        moveBtn.disabled = false;
        moveBtn.innerHTML = `
          <span class="material-icons">drive_file_move</span>
          Move User
        `;
      }
    }
  }

  close(): void {
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
    }
  }
}
