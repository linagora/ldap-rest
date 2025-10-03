/**
 * TreeRoot component - renders the root container and tree
 */

import type { TreeState } from '../types';
import type { Store } from '../store/Store';
import { TreeNodeComponent } from './TreeNode';

export class TreeRoot {
  constructor(
    private store: Store<TreeState>,
    private onClick: (dn: string) => void,
    private onToggle: (dn: string) => void
  ) {}

  render(): HTMLElement {
    const state = this.store.getState();
    const container = document.createElement('div');
    container.className = 'ldap-tree-viewer';

    // Error state
    if (state.error) {
      const error = this.createError(state.error);
      container.appendChild(error);
      return container;
    }

    // Loading state (no root yet)
    if (!state.rootDn) {
      const loading = this.createLoading();
      container.appendChild(loading);
      return container;
    }

    // Tree
    const ul = document.createElement('ul');
    ul.className = 'mdc-tree-root';
    ul.setAttribute('role', 'tree');

    const rootComponent = new TreeNodeComponent(
      state.rootDn,
      this.store,
      this.onToggle,
      this.onClick
    );

    ul.appendChild(rootComponent.render());
    container.appendChild(ul);

    return container;
  }

  private createError(errorMessage: string): HTMLElement {
    const error = document.createElement('div');
    error.className = 'mdc-tree-error';
    error.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'material-icons mdc-tree-error__icon';
    icon.textContent = 'error_outline';

    const message = document.createElement('span');
    message.className = 'mdc-tree-error__message';
    message.textContent = errorMessage;

    error.appendChild(icon);
    error.appendChild(message);

    return error;
  }

  private createLoading(): HTMLElement {
    const loading = document.createElement('div');
    loading.className = 'mdc-tree-loading';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');

    const spinner = document.createElement('div');
    spinner.className = 'mdc-circular-progress mdc-circular-progress--indeterminate';
    spinner.setAttribute('role', 'progressbar');
    spinner.setAttribute('aria-label', 'Loading tree');

    spinner.innerHTML = `
      <div class="mdc-circular-progress__determinate-container">
        <svg class="mdc-circular-progress__determinate-circle-graphic" viewBox="0 0 48 48">
          <circle class="mdc-circular-progress__determinate-track" cx="24" cy="24" r="18" stroke-width="4"/>
          <circle class="mdc-circular-progress__determinate-circle" cx="24" cy="24" r="18" stroke-dasharray="113.097" stroke-dashoffset="113.097" stroke-width="4"/>
        </svg>
      </div>
      <div class="mdc-circular-progress__indeterminate-container">
        <div class="mdc-circular-progress__spinner-layer">
          <div class="mdc-circular-progress__circle-clipper mdc-circular-progress__circle-left">
            <svg class="mdc-circular-progress__indeterminate-circle-graphic" viewBox="0 0 48 48">
              <circle cx="24" cy="24" r="18" stroke-dasharray="113.097" stroke-dashoffset="56.549" stroke-width="4"/>
            </svg>
          </div>
          <div class="mdc-circular-progress__gap-patch">
            <svg class="mdc-circular-progress__indeterminate-circle-graphic" viewBox="0 0 48 48">
              <circle cx="24" cy="24" r="18" stroke-dasharray="113.097" stroke-dashoffset="56.549" stroke-width="3.8" style="stroke-dashoffset: 0"/>
            </svg>
          </div>
          <div class="mdc-circular-progress__circle-clipper mdc-circular-progress__circle-right">
            <svg class="mdc-circular-progress__indeterminate-circle-graphic" viewBox="0 0 48 48">
              <circle cx="24" cy="24" r="18" stroke-dasharray="113.097" stroke-dashoffset="56.549" stroke-width="4"/>
            </svg>
          </div>
        </div>
      </div>
    `;

    const text = document.createElement('span');
    text.className = 'mdc-tree-loading__text';
    text.textContent = 'Loading LDAP tree...';

    loading.appendChild(spinner);
    loading.appendChild(text);

    return loading;
  }
}
