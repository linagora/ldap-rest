/**
 * LDAP Resource Editor - Generic Type Definitions
 */

export type ResourceType = 'users' | 'groups' | 'organizations';
export type NavigationType = 'flat' | 'tree';

export interface EditorOptions {
  containerId: string;
  resourceType: ResourceType;
  apiBaseUrl?: string;
  navigationType?: NavigationType;
  onResourceSaved?: (resourceDn: string) => void;
  onError?: (error: Error) => void;
}

export interface LdapResource {
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
  ui?: 'select' | 'search';
  group?: string;
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
    ldapFlatGeneric?: {
      flatResources?: FlatResourceConfig[];
    };
  };
}

export interface ResourceTypeConfig {
  singularName: string;
  pluralName: string;
  icon: string;
  emptyStateMessage: string;
}
