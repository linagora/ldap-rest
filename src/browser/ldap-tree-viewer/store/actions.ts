/**
 * Action types and action creators
 */

import type { TreeNode } from '../types';

import type { Action } from './Store';

export const Actions = {
  SET_ROOT: 'SET_ROOT',
  ADD_NODE: 'ADD_NODE',
  UPDATE_NODE: 'UPDATE_NODE',
  TOGGLE_EXPANDED: 'TOGGLE_EXPANDED',
  SET_LOADING: 'SET_LOADING',
  SET_ERROR: 'SET_ERROR',
  SELECT_NODE: 'SELECT_NODE',
  SET_SEARCH: 'SET_SEARCH',
  SET_FILTER: 'SET_FILTER',
} as const;

export const setRoot = (node: TreeNode): Action => ({
  type: Actions.SET_ROOT,
  payload: node,
});

export const addNode = (node: TreeNode): Action => ({
  type: Actions.ADD_NODE,
  payload: node,
});

export const updateNode = (node: TreeNode): Action => ({
  type: Actions.UPDATE_NODE,
  payload: node,
});

export const toggleExpanded = (dn: string): Action => ({
  type: Actions.TOGGLE_EXPANDED,
  payload: dn,
});

export const setLoading = (payload: {
  dn: string;
  loading: boolean;
}): Action => ({
  type: Actions.SET_LOADING,
  payload,
});

export const setError = (error: string | null): Action => ({
  type: Actions.SET_ERROR,
  payload: error,
});

export const selectNode = (dn: string | null): Action => ({
  type: Actions.SELECT_NODE,
  payload: dn,
});

export const setSearch = (query: string): Action => ({
  type: Actions.SET_SEARCH,
  payload: query,
});

export const setFilter = (
  filter: 'all' | 'organizations' | 'users' | 'groups'
): Action => ({
  type: Actions.SET_FILTER,
  payload: filter,
});
