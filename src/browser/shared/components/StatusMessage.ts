/**
 * Status message component for displaying notifications
 * @module browser/shared/components/StatusMessage
 */

import { escapeHtml, getElementByIdSafe } from '../utils/dom';

export type StatusType = 'error' | 'success' | 'info' | 'warning';

export interface StatusMessageOptions {
  containerId: string;
  duration?: number; // Duration in ms, 0 for persistent
  dismissible?: boolean;
}

export class StatusMessage {
  private container: HTMLElement | null = null;
  private options: StatusMessageOptions;
  private timeoutId: number | null = null;

  constructor(options: StatusMessageOptions) {
    this.options = {
      duration: 5000,
      dismissible: true,
      ...options,
    };
    this.container = getElementByIdSafe(options.containerId);

    if (!this.container) {
      throw new Error(
        `Status container with id "${options.containerId}" not found`
      );
    }
  }

  /**
   * Show a status message
   */
  show(message: string, type: StatusType = 'info'): void {
    if (!this.container) return;

    // Clear any existing timeout
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    const iconMap: Record<StatusType, string> = {
      error: 'error_outline',
      success: 'check_circle',
      info: 'info',
      warning: 'warning',
    };

    const icon = iconMap[type] || 'info';

    let html = `
      <div class="status-message ${escapeHtml(type)}">
        <span class="material-icons">${icon}</span>
        <span class="status-message-text">${escapeHtml(message)}</span>
    `;

    if (this.options.dismissible) {
      html += `
        <button class="status-message-close" type="button" aria-label="Close">
          <span class="material-icons">close</span>
        </button>
      `;
    }

    html += '</div>';

    this.container.innerHTML = html;

    // Attach close button handler
    if (this.options.dismissible) {
      const closeBtn = this.container.querySelector('.status-message-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hide());
      }
    }

    // Auto-hide after duration
    if (this.options.duration && this.options.duration > 0) {
      this.timeoutId = window.setTimeout(() => {
        this.hide();
      }, this.options.duration);
    }
  }

  /**
   * Show error message
   */
  error(message: string): void {
    this.show(message, 'error');
  }

  /**
   * Show success message
   */
  success(message: string): void {
    this.show(message, 'success');
  }

  /**
   * Show info message
   */
  info(message: string): void {
    this.show(message, 'info');
  }

  /**
   * Show warning message
   */
  warning(message: string): void {
    this.show(message, 'warning');
  }

  /**
   * Hide the status message
   */
  hide(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Get the container element
   */
  getContainer(): HTMLElement | null {
    return this.container;
  }
}

/**
 * Simple functional API for showing status messages
 */
export function showStatus(
  containerId: string,
  message: string,
  type: StatusType = 'info',
  duration = 5000
): void {
  const statusMessage = new StatusMessage({ containerId, duration });
  statusMessage.show(message, type);
}
