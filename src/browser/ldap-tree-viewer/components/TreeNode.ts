/**
 * TreeNode component - renders individual tree nodes
 */

import type { TreeNode as TreeNodeData, TreeState } from '../types';
import type { Store } from '../store/Store';

export class TreeNodeComponent {
  constructor(
    private dn: string,
    private store: Store<TreeState>,
    private onToggle: (dn: string) => void,
    private onClick: (dn: string) => void
  ) {}

  render(): HTMLElement {
    const state = this.store.getState();
    const node = state.nodes.get(this.dn);

    if (!node) {
      const li = document.createElement('li');
      li.className = 'mdc-tree-node mdc-tree-node--error';
      li.textContent = `Node not found: ${this.dn}`;
      return li;
    }

    const isExpanded = state.expandedNodes.has(this.dn);
    const isLoading = state.loadingNodes.has(this.dn);
    const isSelected = state.selectedNode === this.dn;

    const li = document.createElement('li');
    li.className = this.getClassNames(node, isExpanded, isSelected, isLoading);
    li.dataset.dn = this.dn;

    // Node content
    const content = this.createContent(node, isExpanded, isLoading);
    li.appendChild(content);

    // Children
    if (isExpanded && node.childrenDns.length > 0) {
      const childrenUl = document.createElement('ul');
      childrenUl.className = 'mdc-tree-node__children';

      node.childrenDns.forEach(childDn => {
        const childComponent = new TreeNodeComponent(
          childDn,
          this.store,
          this.onToggle,
          this.onClick
        );
        childrenUl.appendChild(childComponent.render());
      });

      li.appendChild(childrenUl);
    }

    return li;
  }

  private createContent(
    node: TreeNodeData,
    isExpanded: boolean,
    isLoading: boolean
  ): HTMLElement {
    const div = document.createElement('div');
    div.className = 'mdc-tree-node__content';

    // Toggle button or spacer
    if (node.hasChildren) {
      const toggle = document.createElement('button');
      toggle.className = 'mdc-tree-node__toggle mdc-icon-button';
      toggle.setAttribute('aria-label', isExpanded ? 'Collapse' : 'Expand');
      toggle.innerHTML = `<span class="material-icons">${
        isExpanded ? 'expand_more' : 'chevron_right'
      }</span>`;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onToggle(this.dn);
      });
      div.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'mdc-tree-node__spacer';
      div.appendChild(spacer);
    }

    // Icon
    const icon = document.createElement('span');
    icon.className = 'mdc-tree-node__icon material-icons';
    icon.textContent = this.getIcon(node.type);
    div.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'mdc-tree-node__label';
    label.textContent = node.displayName;
    label.title = node.dn; // Tooltip with full DN
    div.appendChild(label);

    // Loading spinner
    if (isLoading) {
      const spinner = this.createSpinner();
      div.appendChild(spinner);
    }

    // Click handler on content
    div.addEventListener('click', () => {
      this.onClick(this.dn);
    });

    return div;
  }

  private createSpinner(): HTMLElement {
    const spinner = document.createElement('div');
    spinner.className = 'mdc-circular-progress mdc-circular-progress--small mdc-circular-progress--indeterminate';
    spinner.setAttribute('role', 'progressbar');
    spinner.setAttribute('aria-label', 'Loading');

    spinner.innerHTML = `
      <div class="mdc-circular-progress__determinate-container">
        <svg class="mdc-circular-progress__determinate-circle-graphic" viewBox="0 0 24 24">
          <circle class="mdc-circular-progress__determinate-track" cx="12" cy="12" r="8.75" stroke-width="2.5"/>
          <circle class="mdc-circular-progress__determinate-circle" cx="12" cy="12" r="8.75" stroke-dasharray="54.978" stroke-dashoffset="54.978" stroke-width="2.5"/>
        </svg>
      </div>
      <div class="mdc-circular-progress__indeterminate-container">
        <div class="mdc-circular-progress__spinner-layer">
          <div class="mdc-circular-progress__circle-clipper mdc-circular-progress__circle-left">
            <svg class="mdc-circular-progress__indeterminate-circle-graphic" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.75" stroke-dasharray="54.978" stroke-dashoffset="27.489" stroke-width="2.5"/>
            </svg>
          </div>
          <div class="mdc-circular-progress__gap-patch">
            <svg class="mdc-circular-progress__indeterminate-circle-graphic" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.75" stroke-dasharray="54.978" stroke-dashoffset="27.489" stroke-width="2" style="stroke-dashoffset: 0"/>
            </svg>
          </div>
          <div class="mdc-circular-progress__circle-clipper mdc-circular-progress__circle-right">
            <svg class="mdc-circular-progress__indeterminate-circle-graphic" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.75" stroke-dasharray="54.978" stroke-dashoffset="27.489" stroke-width="2.5"/>
            </svg>
          </div>
        </div>
      </div>
    `;

    return spinner;
  }

  private getClassNames(
    node: TreeNodeData,
    isExpanded: boolean,
    isSelected: boolean,
    isLoading: boolean
  ): string {
    const classes = [
      'mdc-tree-node',
      `mdc-tree-node--${node.type}`
    ];

    if (isExpanded) classes.push('mdc-tree-node--expanded');
    if (isSelected) classes.push('mdc-tree-node--selected');
    if (isLoading) classes.push('mdc-tree-node--loading');

    return classes.join(' ');
  }

  private getIcon(type: string): string {
    const icons: Record<string, string> = {
      organization: 'folder',
      user: 'person',
      group: 'group'
    };
    return icons[type] || 'help';
  }
}
