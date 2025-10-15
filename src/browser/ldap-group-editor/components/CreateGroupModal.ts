/**
 * Create Group Modal Component - Modal for creating a new group
 */

import type { GroupApiClient } from '../api/GroupApiClient';
import type { Config } from '../types';

export class CreateGroupModal {
  private api: GroupApiClient;
  private config: Config;
  private orgDn: string;
  private onCreated: () => Promise<void>;
  private modal: HTMLElement | null = null;

  constructor(
    api: GroupApiClient,
    config: Config,
    orgDn: string,
    onCreated: () => Promise<void>
  ) {
    this.api = api;
    this.config = config;
    this.orgDn = orgDn;
    this.onCreated = onCreated;
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

    // Get organization path for the new group
    const orgPath = await this.getOrgPath(this.orgDn);

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    `;

    modalContent.innerHTML = `
      <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
        <span class="material-icons">group_add</span>
        Create New Group
      </h3>
      <form id="create-group-form" style="display: flex; flex-direction: column; gap: 16px;">
        <div>
          <label for="group-cn" style="display: block; margin-bottom: 4px; font-weight: 500;">Group Name (cn) *</label>
          <input type="text" id="group-cn" required pattern="[a-zA-Z][a-zA-Z0-9-]{0,254}"
            style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;"
            placeholder="e.g., developers" />
          <small style="color: #666; font-size: 12px;">Must start with a letter, contain only letters, numbers, and hyphens</small>
        </div>

        <div>
          <label for="group-mail" style="display: block; margin-bottom: 4px; font-weight: 500;">Email Address</label>
          <input type="email" id="group-mail"
            style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;"
            placeholder="e.g., developers@example.com" />
        </div>

        <div>
          <label for="group-description" style="display: block; margin-bottom: 4px; font-weight: 500;">Description</label>
          <textarea id="group-description" rows="3"
            style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; resize: vertical;"
            placeholder="Group description..."></textarea>
        </div>

        <div style="padding: 12px; background: #f5f5f5; border-radius: 4px;">
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #666;">Organization:</p>
          <p style="margin: 0; font-weight: 500;">${this.escapeHtml(orgPath || this.orgDn)}</p>
        </div>

        <div id="error-message" style="display: none; padding: 12px; background: #ffebee; border-radius: 4px; color: #c62828;"></div>

        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button type="button" id="cancel-create-btn" style="padding: 10px 20px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer;">Cancel</button>
          <button type="submit" style="padding: 10px 20px; background: var(--primary-color, #6200ee); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <span class="material-icons" style="font-size: 18px;">group_add</span>
            Create Group
          </button>
        </div>
      </form>
    `;

    this.modal.appendChild(modalContent);
    document.body.appendChild(this.modal);

    // Attach event listeners
    const cancelBtn = this.modal.querySelector('#cancel-create-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.close());
    }

    const form = this.modal.querySelector('#create-group-form');
    if (form) {
      form.addEventListener('submit', e => this.handleSubmit(e));
    }

    // Click outside to close
    this.modal.addEventListener('click', e => {
      if (e.target === this.modal) {
        this.close();
      }
    });
  }

  private async getOrgPath(orgDn: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.api['baseUrl']}/api/v1/ldap/organizations/${encodeURIComponent(orgDn)}`
      );
      if (!response.ok) return null;

      const org = await response.json();
      const pathAttr = (this.config as any).features?.organizations?.pathAttribute as string | undefined;
      if (pathAttr && org[pathAttr]) {
        return Array.isArray(org[pathAttr]) ? org[pathAttr][0] : org[pathAttr];
      }
      // If no path attribute, use the DN as fallback (for root organization)
      return orgDn;
    } catch (error) {
      console.error('Failed to load organization path:', error);
      return null;
    }
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();

    const cnInput = this.modal?.querySelector('#group-cn') as HTMLInputElement;
    const mailInput = this.modal?.querySelector(
      '#group-mail'
    ) as HTMLInputElement;
    const descInput = this.modal?.querySelector(
      '#group-description'
    ) as HTMLTextAreaElement;
    const errorDiv = this.modal?.querySelector(
      '#error-message'
    ) as HTMLDivElement;

    if (!cnInput) return;

    const cn = cnInput.value.trim();
    if (!cn) {
      this.showError(errorDiv, 'Group name is required');
      return;
    }

    try {
      // Get the group branch from config
      const groupBranch = this.config.ldap_groups_branch as string;
      const dn = `cn=${cn},${groupBranch}`;

      // Get organization path for the group
      const orgPath = await this.getOrgPath(this.orgDn);

      // Build group data - only send cn, the backend will add objectClass, member, and default attributes
      const groupData: Record<string, any> = {
        cn: cn,
      };

      // Add optional fields
      if (mailInput?.value.trim()) {
        groupData.mail = mailInput.value.trim();
      }

      if (descInput?.value.trim()) {
        groupData.description = descInput.value.trim();
      }

      // Add organization link and path (required for twake groups)
      const linkAttr = (this.config as any).features?.organizations?.linkAttribute as
        | string
        | undefined;
      const pathAttr = (this.config as any).features?.organizations?.pathAttribute as
        | string
        | undefined;

      if (linkAttr && pathAttr) {
        if (!orgPath) {
          this.showError(errorDiv, 'Failed to get organization path');
          return;
        }
        groupData[linkAttr] = this.orgDn;
        groupData[pathAttr] = orgPath;
      }

      // Create the group using the proper API
      const response = await fetch(`${this.api['baseUrl']}/api/v1/ldap/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(groupData),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Failed to create group');
      }

      // Call success callback and close
      await this.onCreated();
      this.close();
    } catch (error) {
      console.error('Failed to create group:', error);
      this.showError(errorDiv, (error as Error).message);
    }
  }

  private showError(errorDiv: HTMLDivElement | null, message: string): void {
    if (errorDiv) {
      errorDiv.textContent = `Error: ${message}`;
      errorDiv.style.display = 'block';
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
