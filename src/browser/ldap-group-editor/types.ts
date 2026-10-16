/**
 * TypeScript types for LDAP Group Editor
 */

import type { LocalizedText } from '../shared/types';

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
    ldapOrganizations?: {
      linkAttribute?: string;
      pathAttribute?: string;
    };
  };
  [key: string]: unknown;
}

/** An entry as the API returns it */
export type Entry = { dn: string } & Record<string, unknown>;

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

export interface LdapGroup {
  dn: string;
  cn: string;
  description?: string;
  member?: string[];
  owner?: string[];
  mail?: string;
  [key: string]: unknown;
}
