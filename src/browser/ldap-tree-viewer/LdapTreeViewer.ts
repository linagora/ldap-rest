/**
 * Main LdapTreeViewer class
 */

import type { ViewerOptions, TreeNode, TreeState } from './types';
import { Store } from './store/Store';
import { treeReducer, initialState } from './store/reducers';
import {
  setRoot,
  addNode,
  updateNode,
  toggleExpanded,
  setLoading,
  setError,
  selectNode,
} from './store/actions';
import { LdapApiClient } from './api/LdapApiClient';
import { TreeRoot } from './components/TreeRoot';

export class LdapTreeViewer {
  private store: Store<TreeState>;
  private api: LdapApiClient;
  private container: HTMLElement;
  private rootComponent: TreeRoot | null = null;
  private unsubscribe?: () => void;

  constructor(private options: ViewerOptions) {
    const container = document.getElementById(options.containerId);
    if (!container) {
      throw new Error(`Container element #${options.containerId} not found`);
    }
    this.container = container;
    this.container.classList.add('ldap-tree-viewer-container');

    // Apply theme
    if (options.theme) {
      this.container.classList.add(`ldap-tree-viewer--${options.theme}`);
    }

    this.api = new LdapApiClient(options.apiBaseUrl, options.authToken);
    this.store = new Store(treeReducer, initialState);
  }

  async init(): Promise<void> {
    try {
      // Load root organization
      const rootData = await this.api.getTopOrganization();
      const rootNode = this.transformToTreeNode(rootData);

      this.store.dispatch(setRoot(rootNode));

      // Create root component
      this.rootComponent = new TreeRoot(
        this.store,
        this.handleNodeClick.bind(this),
        this.handleNodeToggle.bind(this)
      );

      // Subscribe to state changes for re-rendering
      this.unsubscribe = this.store.subscribe(() => {
        this.render();
      });

      // Initial render
      this.render();
    } catch (error: any) {
      this.store.dispatch(setError(error.message || 'Failed to load LDAP tree'));
      throw error;
    }
  }

  private render(): void {
    if (!this.rootComponent) return;

    const newTree = this.rootComponent.render();

    // Replace content
    this.container.innerHTML = '';
    this.container.appendChild(newTree);
  }

  private async handleNodeToggle(dn: string): Promise<void> {
    const state = this.store.getState();
    const node = state.nodes.get(dn);

    if (!node) return;

    const isExpanded = state.expandedNodes.has(dn);

    if (isExpanded) {
      // Collapse
      this.store.dispatch(toggleExpanded(dn));
    } else {
      // Expand - load children if not loaded yet
      if (!node.hasLoadedChildren && node.hasChildren) {
        await this.loadChildren(dn);
      }
      this.store.dispatch(toggleExpanded(dn));

      // Call onNodeExpand callback
      if (this.options.onNodeExpand) {
        this.options.onNodeExpand(node);
      }
    }
  }

  private async loadChildren(dn: string): Promise<void> {
    this.store.dispatch(setLoading({ dn, loading: true }));

    try {
      const subnodes = await this.api.getOrganizationSubnodes(dn);

      const childDns: string[] = [];

      // Transform and add each node
      subnodes.forEach(nodeData => {
        const node = this.transformToTreeNode(nodeData, dn);
        this.store.dispatch(addNode(node));
        childDns.push(node.dn);
      });

      // Update parent node with children info
      const parentNode = this.store.getState().nodes.get(dn);
      if (parentNode) {
        this.store.dispatch(updateNode({
          ...parentNode,
          hasLoadedChildren: true,
          childrenDns: childDns,
          hasChildren: childDns.length > 0,
        }));
      }
    } catch (error: any) {
      this.store.dispatch(setError(error.message || 'Failed to load children'));
      console.error('Failed to load children for', dn, error);
    } finally {
      this.store.dispatch(setLoading({ dn, loading: false }));
    }
  }

  private handleNodeClick(dn: string): void {
    this.store.dispatch(selectNode(dn));

    const node = this.store.getState().nodes.get(dn);
    if (node && this.options.onNodeClick) {
      this.options.onNodeClick(node);
    }
  }

  private transformToTreeNode(data: any, parentDn: string | null = null): TreeNode {
    // Determine display name
    let displayName = data.ou || data.cn || data.uid || data.dn;
    if (Array.isArray(displayName)) {
      displayName = displayName[0];
    }

    const nodeType = this.detectNodeType(data);

    return {
      dn: data.dn,
      displayName,
      type: nodeType,
      parentDn,
      childrenDns: [],
      hasLoadedChildren: false,
      // Only organizations can have children, 'more' indicator cannot be expanded
      hasChildren: nodeType === 'organization',
      attributes: data,
    };
  }

  private detectNodeType(data: any): 'organization' | 'user' | 'group' | 'more' {
    const objectClass = data.objectClass || [];
    const classes = Array.isArray(objectClass) ? objectClass : [objectClass];

    if (classes.includes('moreIndicator')) {
      return 'more';
    }
    if (classes.includes('organizationalUnit') || classes.includes('organization')) {
      return 'organization';
    }
    if (classes.includes('posixGroup') || classes.includes('groupOfNames')) {
      return 'group';
    }
    return 'user';
  }

  // Public API methods

  async expandNode(dn: string): Promise<void> {
    const state = this.store.getState();
    if (!state.expandedNodes.has(dn)) {
      await this.handleNodeToggle(dn);
    }
  }

  async collapseNode(dn: string): Promise<void> {
    const state = this.store.getState();
    if (state.expandedNodes.has(dn)) {
      this.store.dispatch(toggleExpanded(dn));
    }
  }

  async refresh(): Promise<void> {
    // Clear state and reload
    this.store.dispatch(setError(null));
    await this.init();
  }

  selectNode(dn: string | null): void {
    this.store.dispatch(selectNode(dn));
  }

  getState(): TreeState {
    return this.store.getState();
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.container.innerHTML = '';
    this.container.classList.remove('ldap-tree-viewer-container');
    if (this.options.theme) {
      this.container.classList.remove(`ldap-tree-viewer--${this.options.theme}`);
    }
  }
}
