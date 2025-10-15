/**
 * TypeScript types for LDAP Group Editor
 */

export interface GroupEditorOptions {
  containerId: string;
  apiBaseUrl?: string;
  onGroupSaved?: (groupDn: string) => void;
  onError?: (error: Error) => void;
}

export interface Config {
  ldapBase: string;
  features?: {
    flatResources?: ResourceConfig[];
    ldapFlatGeneric?: {
      flatResources?: ResourceConfig[];
    };
    ldapGroups?: {
      schemaUrl?: string;
      schema?: SchemaDefinition;
    };
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

export interface LdapGroup {
  dn: string;
  cn: string;
  description?: string;
  member?: string[];
  owner?: string[];
  mail?: string;
  [key: string]: unknown;
}
