/**
 * Shared TypeScript types for browser components
 * @module browser/shared/types
 */

export interface EditorConfig {
  ldapBase?: string;
  features?: {
    flatResources?: ResourceConfig[];
  };
  [key: string]: unknown;
}

export interface ResourceConfig {
  name: string;
  pluralName?: string;
  schemaUrl?: string;
  schema?: SchemaDefinition;
  base?: string;
}

export interface SchemaDefinition {
  entity: {
    objectClass?: string[];
    base?: string;
  };
  attributes: Record<string, SchemaAttribute>;
}

export interface SchemaAttribute {
  type: 'string' | 'number' | 'integer' | 'array' | 'pointer';
  required?: boolean;
  fixed?: boolean;
  default?: unknown;
  branch?: string[];
  items?: {
    type: string;
    branch?: string[];
  };
  group?: string;
}

export interface PointerOption {
  dn: string;
  label: string;
}

export interface EditorAPI {
  getPointerOptions(branch: string): Promise<PointerOption[]>;
  createEntry(dn: string, data: Record<string, unknown>): Promise<void>;
  deleteEntry(dn: string): Promise<void>;
  updateEntry(dn: string, data: Record<string, unknown>): Promise<void>;
}

export interface BaseEditor {
  getConfig(): EditorConfig;
  getApi(): EditorAPI;
  getCurrentOrgDn(): string | null;
  getCurrentUserDn?(): string | null;
  init(): Promise<void>;
  createUser?(data: Record<string, unknown>): Promise<void>;
  deleteUser?(dn: string): Promise<void>;
}

export type StatusType = 'error' | 'success' | 'info' | 'warning';

export interface Theme {
  name: string;
  primaryColor: string;
  primaryColorDark: string;
  gradientStart: string;
  gradientEnd: string;
}

export const THEMES: Record<string, Theme> = {
  purple: {
    name: 'Purple',
    primaryColor: '#6200ee',
    primaryColorDark: '#3700b3',
    gradientStart: '#667eea',
    gradientEnd: '#764ba2',
  },
  blue: {
    name: 'Blue',
    primaryColor: '#185a9d',
    primaryColorDark: '#0d3a6b',
    gradientStart: '#43cea2',
    gradientEnd: '#185a9d',
  },
  pink: {
    name: 'Pink',
    primaryColor: '#f5576c',
    primaryColorDark: '#d43d50',
    gradientStart: '#f093fb',
    gradientEnd: '#f5576c',
  },
  green: {
    name: 'Green',
    primaryColor: '#00c853',
    primaryColorDark: '#009624',
    gradientStart: '#56ab2f',
    gradientEnd: '#a8e063',
  },
};
