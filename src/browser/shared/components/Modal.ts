/**
 * Reusable Modal component
 * @module browser/shared/components/Modal
 */

import { escapeHtml, getElementByIdSafe } from '../utils/dom';
import { DisposableComponent } from './DisposableComponent';

export interface ModalOptions {
  id: string;
  title: string;
  onClose?: () => void;
}

export class Modal extends DisposableComponent {
  private overlay: HTMLElement | null = null;
  private options: ModalOptions;

  constructor(options: ModalOptions) {
    super();
    this.options = options;
    this.overlay = getElementByIdSafe(options.id);

    if (!this.overlay) {
      throw new Error(`Modal overlay with id "${options.id}" not found`);
    }

    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    if (!this.overlay) return;

    // Close button
    const closeBtn = this.overlay.querySelector('.close-button');
    if (closeBtn) {
      this.addManagedEventListener(closeBtn, 'click', () => this.close());
    }

    // Cancel button
    const cancelBtn = this.overlay.querySelector('[data-modal-cancel]');
    if (cancelBtn) {
      this.addManagedEventListener(cancelBtn, 'click', () => this.close());
    }

    // Click outside to close
    this.addManagedEventListener(this.overlay, 'click', e => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Escape key to close - now properly cleaned up
    this.addManagedEventListener(document, 'keydown', e => {
      if ((e as KeyboardEvent).key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  open(): void {
    if (this.overlay) {
      this.overlay.classList.add('active');
      document.body.style.overflow = 'hidden'; // Prevent background scroll
    }
  }

  close(): void {
    if (this.overlay) {
      this.overlay.classList.remove('active');
      document.body.style.overflow = ''; // Restore scroll
      if (this.options.onClose) {
        this.options.onClose();
      }
    }
  }

  /**
   * Clean up all event listeners and resources
   */
  override destroy(): void {
    this.close();
    super.destroy();
    this.overlay = null;
  }

  isOpen(): boolean {
    return this.overlay?.classList.contains('active') || false;
  }

  getFormElement(): HTMLFormElement | null {
    return this.overlay?.querySelector('form') || null;
  }

  resetForm(): void {
    const form = this.getFormElement();
    if (form) {
      form.reset();
    }
  }

  setContent(html: string): void {
    const contentEl = this.overlay?.querySelector('[data-modal-content]');
    if (contentEl) {
      contentEl.innerHTML = html;
    }
  }

  setTitle(title: string): void {
    const titleEl = this.overlay?.querySelector('.modal-header h2');
    if (titleEl) {
      titleEl.textContent = title;
    }
  }

  /**
   * Create modal HTML structure
   */
  static createModalHTML(options: {
    id: string;
    title: string;
    formId?: string;
    submitLabel?: string;
  }): string {
    const formId = options.formId || `${options.id}-form`;
    const submitLabel = options.submitLabel || 'Submit';

    return `
      <div class="modal-overlay" id="${escapeHtml(options.id)}">
        <div class="modal">
          <div class="modal-header">
            <h2>${escapeHtml(options.title)}</h2>
            <button class="close-button" type="button">
              <span class="material-icons">close</span>
            </button>
          </div>
          <form id="${escapeHtml(formId)}">
            <div data-modal-content></div>
            <div class="modal-footer">
              <button type="button" class="secondary" data-modal-cancel>
                Cancel
              </button>
              <button type="submit" class="primary">${escapeHtml(submitLabel)}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  /**
   * Create and inject modal into DOM
   */
  static create(
    options: ModalOptions & {
      formId?: string;
      submitLabel?: string;
    }
  ): Modal {
    const html = Modal.createModalHTML(options);
    document.body.insertAdjacentHTML('beforeend', html);
    return new Modal(options);
  }
}
