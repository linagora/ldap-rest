/**
 * TypeScript interfaces and types for LDAP Tree Viewer
 */

export interface TreeState {
  nodes: Map<string, TreeNode>;
  rootDn: string | null;
  expandedNodes: Set<string>;
  loadingNodes: Set<string>;
  selectedNode: string | null;
  error: string | null;
  searchQuery: string;
  filter: 'all' | 'organizations' | 'users' | 'groups';
}

export interface TreeNode {
  dn: string;
  displayName: string;
  type: 'organization' | 'user' | 'group' | 'more';
  parentDn: string | null;
  childrenDns: string[];
  hasLoadedChildren: boolean;
  hasChildren: boolean;
  attributes?: Record<string, unknown>;
}

export interface ViewerOptions {
  containerId: string;
  apiBaseUrl: string;
  authToken?: string;
  rootDn?: string;
  theme?: 'light' | 'dark';
  onNodeClick?: (node: TreeNode) => void;
  onNodeExpand?: (node: TreeNode) => void;
}

export type NodeType = 'organization' | 'user' | 'group' | 'more';
export type FilterType = 'all' | 'organizations' | 'users' | 'groups';
