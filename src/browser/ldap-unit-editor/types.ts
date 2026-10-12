/**
 * TypeScript types for LDAP Unit Editor
 */

import type { LocalizedText } from '../shared/types';

export interface UnitEditorOptions {
  containerId: string;
  apiBaseUrl?: string;
  onUnitSaved?: (unitDn: string) => void;
  onError?: (error: Error) => void;
}

export interface Config {
  ldapBase: string;
  features?: {
    flatResources?: ResourceConfig[];
    ldapFlatGeneric?: {
      flatResources?: ResourceConfig[];
    };
    ldapOrganizations?: {
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
  group?: LocalizedText;
}

export interface LdapUnit {
  dn: string;
  ou: string;
  description?: string;
  [key: string]: unknown;
}
