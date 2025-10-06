/**
 * LDAP User Editor - Type definitions
 */

export interface EditorOptions {
  containerId: string;
  apiBaseUrl?: string;
  onUserSaved?: (userDn: string) => void;
  onError?: (error: Error) => void;
}

export interface LdapUser {
  dn: string;
  [key: string]: unknown;
}

export interface SchemaAttribute {
  type: string;
  required?: boolean;
  fixed?: boolean;
  role?: string;
  test?: string;
  branch?: string[];
  items?: SchemaAttribute;
  default?: unknown;
  ui?: 'select' | 'search'; // For pointer fields: select (load all) or search (autocomplete)
}

export interface Schema {
  entity: {
    name: string;
    mainAttribute: string;
    objectClass: string[];
    singularName: string;
    pluralName: string;
    base: string;
  };
  strict: boolean;
  attributes: Record<string, SchemaAttribute>;
}

export interface PointerOption {
  dn: string;
  label: string;
}

export interface FlatResourceConfig {
  name: string;
  singularName: string;
  pluralName: string;
  mainAttribute: string;
  objectClass: string[];
  base: string;
  schema?: Schema;
  schemaUrl?: string;
  endpoints: {
    list: string;
    get: string;
    create: string;
    update: string;
    delete: string;
  };
}

export interface Config {
  apiPrefix: string;
  ldapBase: string;
  features?: {
    flatResources?: FlatResourceConfig[];
  };
}
