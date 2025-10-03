/**
 * Reducers for tree state management
 */

import type { TreeState, TreeNode } from '../types';
import type { Action } from './Store';
import { Actions } from './actions';

export const initialState: TreeState = {
  nodes: new Map(),
  rootDn: null,
  expandedNodes: new Set(),
  loadingNodes: new Set(),
  selectedNode: null,
  error: null,
  searchQuery: '',
  filter: 'all',
};

export function treeReducer(state: TreeState, action: Action): TreeState {
  switch (action.type) {
    case Actions.SET_ROOT: {
      const rootNode = action.payload as TreeNode;
      return {
        ...state,
        rootDn: rootNode.dn,
        nodes: new Map([[rootNode.dn, rootNode]]),
        error: null,
      };
    }

    case Actions.ADD_NODE: {
      const newNode = action.payload as TreeNode;
      const nodes = new Map(state.nodes);
      nodes.set(newNode.dn, newNode);
      return { ...state, nodes };
    }

    case Actions.UPDATE_NODE: {
      const updatedNode = action.payload as TreeNode;
      const nodes = new Map(state.nodes);
      nodes.set(updatedNode.dn, updatedNode);
      return { ...state, nodes };
    }

    case Actions.TOGGLE_EXPANDED: {
      const dn = action.payload as string;
      const expanded = new Set(state.expandedNodes);
      if (expanded.has(dn)) {
        expanded.delete(dn);
      } else {
        expanded.add(dn);
      }
      return { ...state, expandedNodes: expanded };
    }

    case Actions.SET_LOADING: {
      const { dn, loading } = action.payload as {
        dn: string;
        loading: boolean;
      };
      const loadingNodes = new Set(state.loadingNodes);
      if (loading) {
        loadingNodes.add(dn);
      } else {
        loadingNodes.delete(dn);
      }
      return { ...state, loadingNodes };
    }

    case Actions.SET_ERROR: {
      return { ...state, error: action.payload as string | null };
    }

    case Actions.SELECT_NODE: {
      return { ...state, selectedNode: action.payload as string | null };
    }

    case Actions.SET_SEARCH: {
      return { ...state, searchQuery: action.payload as string };
    }

    case Actions.SET_FILTER: {
      return { ...state, filter: action.payload as TreeState['filter'] };
    }

    default:
      return state;
  }
}
