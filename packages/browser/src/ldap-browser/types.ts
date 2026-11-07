/**
 * Types of the low-level LDAP browser, mirroring the responses of the
 * `core/ldap/raw` server plugin.
 * @module browser/ldap-browser/types
 */

/** Values of a single attribute; base64-encoded when `binary` is true */
export interface RawAttribute {
  values: string[];
  binary: boolean;
}

/** A directory entry with all its attributes */
export interface RawEntry {
  dn: string;
  attributes: Record<string, RawAttribute>;
}

/** Direct child of an entry, as needed to draw a tree node */
export interface RawChild {
  dn: string;
  rdn: string;
  objectClass: string[];
  hasChildren: boolean;
}

/** Direct children of an entry, with the truncation flag */
export interface RawChildren {
  children: RawChild[];
  /** True when the server's result limit cut the listing short */
  truncated: boolean;
}

/** Result of a raw search */
export interface RawSearchResult {
  entries: RawEntry[];
  truncated: boolean;
}

/** Parsed `objectClasses` definition */
export interface ObjectClassDefinition {
  oid: string;
  names: string[];
  desc?: string;
  obsolete: boolean;
  sup: string[];
  kind: 'STRUCTURAL' | 'ABSTRACT' | 'AUXILIARY';
  must: string[];
  may: string[];
}

/** Parsed `attributeTypes` definition */
export interface AttributeTypeDefinition {
  oid: string;
  names: string[];
  desc?: string;
  obsolete: boolean;
  sup?: string;
  equality?: string;
  ordering?: string;
  substr?: string;
  syntax?: string;
  syntaxLength?: number;
  singleValue: boolean;
  collective: boolean;
  noUserModification: boolean;
  usage: string;
}

/** Parsed `ldapSyntaxes` definition */
export interface SyntaxDefinition {
  oid: string;
  desc?: string;
  binary: boolean;
}

/** Parsed `matchingRules` definition */
export interface MatchingRuleDefinition {
  oid: string;
  names: string[];
  desc?: string;
  syntax?: string;
}

/** Whole schema as served by `GET /api/v1/ldap/raw/schema` */
export interface LdapSchema {
  objectClasses: ObjectClassDefinition[];
  attributeTypes: AttributeTypeDefinition[];
  syntaxes: SyntaxDefinition[];
  matchingRules: MatchingRuleDefinition[];
}

/** Options of the {@link LdapBrowser} constructor */
export interface BrowserOptions {
  /** id of the element the browser renders into */
  containerId: string;
  /** Origin of the API, e.g. `window.location.origin` */
  apiBaseUrl?: string;
  /** Bearer token sent with every request */
  authToken?: string;
  /** DN to select on startup; defaults to the first exposed base */
  initialDn?: string;
  /** Called whenever an entry is displayed */
  onEntrySelected?: (dn: string) => void;
  /** Called on any error the browser handles itself */
  onError?: (error: Error) => void;
}
