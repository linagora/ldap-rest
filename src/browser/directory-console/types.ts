/**
 * Types of the directory console.
 *
 * Everything the console knows about a directory comes from
 * `GET {apiPrefix}/v1/config` and from the schemas it points at. No entity
 * name, attribute name or label is written here: an entity the deployment
 * adds appears in the interface without a line of code.
 *
 * @module browser/directory-console/types
 */

/** Semantic role of an attribute, as declared by the server-side schema. */
export type SchemaRole = string;

/** One attribute of an entity schema. */
export interface SchemaAttribute {
  type:
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'date'
    | 'array'
    | 'pointer';
  items?: { type: string; test?: string; hint?: string; branch?: string[] };
  default?: unknown;
  required?: boolean;
  test?: string;
  /** Plain-language description of `test`, shown under the field */
  hint?: string;
  branch?: string[];
  fixed?: boolean;
  role?: SchemaRole | SchemaRole[];
  /** Computed server-side: shown, never edited */
  generated?: boolean;
  /** How the server derives a generated value from another attribute */
  generatedFrom?: {
    attribute: string;
    extract?: string;
    lowercase?: boolean;
    onCollision?: 'error' | 'suffix';
    regenerateOnChange?: boolean;
  };
  /** Derived elsewhere: shown, never edited */
  readOnly?: boolean;
  /** Never returned by the API: offered on creation only */
  neverReturn?: boolean;
  /** Named lifecycle states this attribute can be moved to */
  states?: Record<string, string>;
  /** Grouping hint for the form */
  group?: string;
  /** Label to show instead of the attribute name */
  label?: string;
}

export interface EntitySchema {
  strict?: boolean;
  attributes: Record<string, SchemaAttribute>;
}

/** An entity the console can browse, as advertised by the server. */
export interface EntityDescriptor {
  /** Key used in the URL fragment and in the sidebar */
  key: string;
  /** Plural name, from the schema — the deployment's own vocabulary */
  pluralName: string;
  singularName: string;
  /** Attribute holding the RDN value */
  mainAttribute: string;
  base: string;
  schema: EntitySchema;
  /** Base path of the REST collection */
  endpoint: string;
  /** How the console presents it */
  kind: 'flat' | 'group' | 'organization';
  /** Attribute carrying the DN of the owning organization, when there is one */
  organizationLink?: string;
  /** Attribute carrying the readable path of that organization */
  organizationPath?: string;
  /** Attribute carrying the lifecycle state, when the entity has one */
  accountStatus?: string;
  /** Attribute carrying the credential, when the entity has one */
  password?: string;
}

/** A single directory entry, as the API returns it. */
export type Entry = Record<string, string | string[] | undefined> & {
  dn?: string;
};

/** Answer of `GET /v1/authz/scope`. */
export interface Scope {
  user: string | null;
  unrestricted: boolean;
  branches: {
    dn: string;
    name?: string;
    path?: string;
    read?: boolean;
    write?: boolean;
    delete?: boolean;
  }[];
  entities: { name: string; base: string; create: boolean }[];
}

/** Options accepted by the console. */
export interface ConsoleOptions {
  /** Id of the element the console renders into */
  containerId: string;
  /** Origin of the API; defaults to the page's own */
  apiBaseUrl?: string;
  /** Interface language; defaults to the browser's, falling back to English */
  language?: string;
}

/** One organization of the tree. */
export interface OrganizationNode {
  dn: string;
  name: string;
  path?: string;
  children?: OrganizationNode[];
  loaded?: boolean;
}
