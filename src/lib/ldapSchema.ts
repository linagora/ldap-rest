/**
 * LDAP schema (RFC 4512) parser
 *
 * The directory publishes its schema as a set of string definitions in the
 * subschema entry (`objectClasses`, `attributeTypes`, `ldapSyntaxes`,
 * `matchingRules`). This module turns those strings into plain objects and
 * resolves the inheritance chains, so a client can know which attributes an
 * entry may carry, which ones are mandatory, and how to render their values.
 *
 * @module lib/ldapSchema
 * @author Xavier Guimard <xguimard@linagora.com>
 */

/** Parsed `attributeTypes` definition (RFC 4512 §4.1.2) */
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
  /** Suggested maximum length, from the `{len}` suffix of the syntax OID */
  syntaxLength?: number;
  singleValue: boolean;
  collective: boolean;
  noUserModification: boolean;
  /** `userApplications` (default), `directoryOperation`, `distributedOperation` or `dSAOperation` */
  usage: string;
}

/** Parsed `objectClasses` definition (RFC 4512 §4.1.1) */
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

/** Parsed `ldapSyntaxes` definition (RFC 4512 §4.1.5) */
export interface SyntaxDefinition {
  oid: string;
  desc?: string;
  /** True when values of this syntax are not human-readable text */
  binary: boolean;
}

/** Parsed `matchingRules` definition (RFC 4512 §4.1.3) */
export interface MatchingRuleDefinition {
  oid: string;
  names: string[];
  desc?: string;
  syntax?: string;
}

/** Whole schema, indexed by lowercase name for lookups */
export interface LdapSchema {
  attributeTypes: AttributeTypeDefinition[];
  objectClasses: ObjectClassDefinition[];
  syntaxes: SyntaxDefinition[];
  matchingRules: MatchingRuleDefinition[];
}

/** Raw definitions as read from the subschema entry */
export interface RawSchemaDefinitions {
  attributeTypes?: string[];
  objectClasses?: string[];
  ldapSyntaxes?: string[];
  matchingRules?: string[];
}

/**
 * Syntaxes whose values are octets rather than text (RFC 4517 and common
 * directory extensions). Values of these syntaxes must be base64-encoded
 * before being sent to a JSON client.
 */
const BINARY_SYNTAXES = new Set([
  '1.3.6.1.4.1.1466.115.121.1.5', // Binary
  '1.3.6.1.4.1.1466.115.121.1.8', // Certificate
  '1.3.6.1.4.1.1466.115.121.1.9', // Certificate List
  '1.3.6.1.4.1.1466.115.121.1.10', // Certificate Pair
  '1.3.6.1.4.1.1466.115.121.1.28', // JPEG
  '1.3.6.1.4.1.1466.115.121.1.40', // Octet String
  '1.3.6.1.4.1.1466.115.121.1.49', // Supported Algorithm
  '1.3.6.1.1.16.1', // UUID (openldap: entryUUID)
]);

/**
 * Attributes always stored as octets whatever their declared syntax. Some
 * servers publish `userPassword` with the Octet String syntax and others with
 * a text syntax; treating it as binary in every case avoids sending mangled
 * UTF-8 to the client.
 */
const BINARY_ATTRIBUTES = new Set([
  'userpassword',
  'jpegphoto',
  'usercertificate',
  'cacertificate',
  'certificaterevocationlist',
  'authoritiyrevocationlist',
  'crosscertificatepair',
  'photo',
  'personalsignature',
  'audio',
  'thumbnailphoto',
  'thumbnaillogo',
  'objectguid',
  'objectsid',
]);

/**
 * Split an RFC 4512 definition into tokens: parentheses are single tokens,
 * single-quoted strings keep their spaces (quotes stripped), everything else
 * is separated by whitespace.
 *
 * @param definition full definition, parentheses included
 * @returns list of tokens, `(` and `)` included
 */
function tokenize(definition: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < definition.length) {
    const c = definition[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
    } else if (c === "'") {
      // Quoted string: `\27` escapes a quote, `\5c` a backslash (RFC 4512 §4.1)
      let value = '';
      i++;
      while (i < definition.length && definition[i] !== "'") {
        if (definition[i] === '\\' && i + 2 < definition.length) {
          const hex = definition.substring(i + 1, i + 3);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            value += String.fromCharCode(parseInt(hex, 16));
            i += 3;
            continue;
          }
        }
        value += definition[i];
        i++;
      }
      i++; // closing quote
      tokens.push(value);
    } else {
      let value = '';
      while (i < definition.length && !/[\s()']/.test(definition[i])) {
        value += definition[i];
        i++;
      }
      tokens.push(value);
    }
  }
  return tokens;
}

/**
 * Read a value list that may be a single item or a parenthesised
 * `$`-separated list, and advance the cursor past it.
 *
 * @param tokens token list
 * @param start index of the first token of the list
 * @returns the values and the index of the first token after the list
 */
function readList(
  tokens: string[],
  start: number
): { values: string[]; next: number } {
  if (tokens[start] !== '(') {
    return { values: [tokens[start]], next: start + 1 };
  }
  const values: string[] = [];
  let i = start + 1;
  while (i < tokens.length && tokens[i] !== ')') {
    if (tokens[i] !== '$') values.push(tokens[i]);
    i++;
  }
  return { values, next: i + 1 };
}

/**
 * Generic RFC 4512 definition parser. Returns the OID plus a map of keyword
 * to values; valueless keywords (`SINGLE-VALUE`, `STRUCTURAL`, …) map to an
 * empty array.
 *
 * @param definition definition string, e.g. `( 2.5.4.3 NAME 'cn' SUP name )`
 * @param valuedKeywords keywords that are followed by one or more values
 * @returns parsed OID and keyword map, or null when the definition is unusable
 */
function parseDefinition(
  definition: string,
  valuedKeywords: Set<string>
): { oid: string; fields: Record<string, string[]> } | null {
  const tokens = tokenize(definition);
  if (tokens.length < 2 || tokens[0] !== '(') return null;

  const oid = tokens[1];
  const fields: Record<string, string[]> = {};
  let i = 2;
  while (i < tokens.length && tokens[i] !== ')') {
    const keyword = tokens[i];
    i++;
    if (valuedKeywords.has(keyword)) {
      const { values, next } = readList(tokens, i);
      fields[keyword] = values;
      i = next;
    } else if (keyword.startsWith('X-')) {
      // Vendor extension: always followed by a value or a value list
      const { next } = readList(tokens, i);
      fields[keyword] = [];
      i = next;
    } else {
      fields[keyword] = [];
    }
  }
  return { oid, fields };
}

const ATTRIBUTE_VALUED_KEYWORDS = new Set([
  'NAME',
  'DESC',
  'SUP',
  'EQUALITY',
  'ORDERING',
  'SUBSTR',
  'SYNTAX',
  'USAGE',
]);

const OBJECTCLASS_VALUED_KEYWORDS = new Set([
  'NAME',
  'DESC',
  'SUP',
  'MUST',
  'MAY',
]);

const SYNTAX_VALUED_KEYWORDS = new Set(['DESC']);

const MATCHING_RULE_VALUED_KEYWORDS = new Set([
  'NAME',
  'DESC',
  'SUP',
  'SYNTAX',
]);

/**
 * Parse an `attributeTypes` definition.
 *
 * @param definition definition string
 * @returns parsed definition, or null when it cannot be parsed
 */
export function parseAttributeType(
  definition: string
): AttributeTypeDefinition | null {
  const parsed = parseDefinition(definition, ATTRIBUTE_VALUED_KEYWORDS);
  if (!parsed) return null;
  const { oid, fields } = parsed;

  // The syntax OID may carry a suggested length: `1.3.6...15{64}`
  let syntax = fields.SYNTAX?.[0];
  let syntaxLength: number | undefined;
  if (syntax) {
    const match = /^(.*?)\{(\d+)\}$/.exec(syntax);
    if (match) {
      syntax = match[1];
      syntaxLength = parseInt(match[2], 10);
    }
  }

  return {
    oid,
    names: fields.NAME || [],
    desc: fields.DESC?.[0],
    obsolete: 'OBSOLETE' in fields,
    sup: fields.SUP?.[0],
    equality: fields.EQUALITY?.[0],
    ordering: fields.ORDERING?.[0],
    substr: fields.SUBSTR?.[0],
    syntax,
    syntaxLength,
    singleValue: 'SINGLE-VALUE' in fields,
    collective: 'COLLECTIVE' in fields,
    noUserModification: 'NO-USER-MODIFICATION' in fields,
    usage: fields.USAGE?.[0] || 'userApplications',
  };
}

/**
 * Parse an `objectClasses` definition.
 *
 * @param definition definition string
 * @returns parsed definition, or null when it cannot be parsed
 */
export function parseObjectClass(
  definition: string
): ObjectClassDefinition | null {
  const parsed = parseDefinition(definition, OBJECTCLASS_VALUED_KEYWORDS);
  if (!parsed) return null;
  const { oid, fields } = parsed;

  const kind: ObjectClassDefinition['kind'] =
    'ABSTRACT' in fields
      ? 'ABSTRACT'
      : 'AUXILIARY' in fields
        ? 'AUXILIARY'
        : 'STRUCTURAL';

  return {
    oid,
    names: fields.NAME || [],
    desc: fields.DESC?.[0],
    obsolete: 'OBSOLETE' in fields,
    sup: fields.SUP || [],
    kind,
    must: fields.MUST || [],
    may: fields.MAY || [],
  };
}

/**
 * Parse an `ldapSyntaxes` definition.
 *
 * @param definition definition string
 * @returns parsed definition, or null when it cannot be parsed
 */
export function parseSyntax(definition: string): SyntaxDefinition | null {
  const parsed = parseDefinition(definition, SYNTAX_VALUED_KEYWORDS);
  if (!parsed) return null;
  return {
    oid: parsed.oid,
    desc: parsed.fields.DESC?.[0],
    binary: BINARY_SYNTAXES.has(parsed.oid),
  };
}

/**
 * Parse a `matchingRules` definition.
 *
 * @param definition definition string
 * @returns parsed definition, or null when it cannot be parsed
 */
export function parseMatchingRule(
  definition: string
): MatchingRuleDefinition | null {
  const parsed = parseDefinition(definition, MATCHING_RULE_VALUED_KEYWORDS);
  if (!parsed) return null;
  return {
    oid: parsed.oid,
    names: parsed.fields.NAME || [],
    desc: parsed.fields.DESC?.[0],
    syntax: parsed.fields.SYNTAX?.[0],
  };
}

/**
 * Parse the four definition lists of a subschema entry. Unparseable
 * definitions are skipped rather than failing the whole schema.
 *
 * @param raw definition strings as read from the subschema entry
 * @returns parsed schema
 */
export function parseSchema(raw: RawSchemaDefinitions): LdapSchema {
  const parseAll = <T>(
    definitions: string[] | undefined,
    parser: (definition: string) => T | null
  ): T[] => (definitions || []).map(parser).filter((d): d is T => d !== null);

  return {
    attributeTypes: parseAll(raw.attributeTypes, parseAttributeType),
    objectClasses: parseAll(raw.objectClasses, parseObjectClass),
    syntaxes: parseAll(raw.ldapSyntaxes, parseSyntax),
    matchingRules: parseAll(raw.matchingRules, parseMatchingRule),
  };
}

/**
 * Indexed view of a schema, with the lookups a client needs: resolution of
 * object class inheritance and detection of binary attributes.
 */
export class SchemaIndex {
  readonly schema: LdapSchema;
  private objectClassesByName = new Map<string, ObjectClassDefinition>();
  private attributeTypesByName = new Map<string, AttributeTypeDefinition>();
  private syntaxesByOid = new Map<string, SyntaxDefinition>();

  constructor(schema: LdapSchema) {
    this.schema = schema;
    for (const oc of schema.objectClasses) {
      this.objectClassesByName.set(oc.oid.toLowerCase(), oc);
      for (const name of oc.names)
        this.objectClassesByName.set(name.toLowerCase(), oc);
    }
    for (const at of schema.attributeTypes) {
      this.attributeTypesByName.set(at.oid.toLowerCase(), at);
      for (const name of at.names)
        this.attributeTypesByName.set(name.toLowerCase(), at);
    }
    for (const syntax of schema.syntaxes)
      this.syntaxesByOid.set(syntax.oid, syntax);
  }

  /**
   * Look up an object class by name or OID (case-insensitive).
   *
   * @param name object class name or OID
   * @returns the definition, or undefined when unknown
   */
  getObjectClass(name: string): ObjectClassDefinition | undefined {
    return this.objectClassesByName.get(name.toLowerCase());
  }

  /**
   * Look up an attribute type by name or OID (case-insensitive).
   *
   * @param name attribute name or OID
   * @returns the definition, or undefined when unknown
   */
  getAttributeType(name: string): AttributeTypeDefinition | undefined {
    // `name;binary` and `name;lang-fr` are options on the base attribute
    const base = name.split(';')[0];
    return this.attributeTypesByName.get(base.toLowerCase());
  }

  /**
   * Resolve the syntax of an attribute, following the `SUP` chain when the
   * attribute does not declare one itself.
   *
   * @param name attribute name or OID
   * @returns syntax OID, or undefined when it cannot be resolved
   */
  getAttributeSyntax(name: string): string | undefined {
    const seen = new Set<string>();
    let current = this.getAttributeType(name);
    while (current && !seen.has(current.oid)) {
      if (current.syntax) return current.syntax;
      seen.add(current.oid);
      current = current.sup ? this.getAttributeType(current.sup) : undefined;
    }
    return undefined;
  }

  /**
   * Tell whether an attribute holds octets rather than text, and therefore
   * must be base64-encoded in JSON.
   *
   * @param name attribute name, options included (`jpegPhoto;binary`)
   * @returns true when values must be treated as binary
   */
  isBinaryAttribute(name: string): boolean {
    const base = name.split(';')[0].toLowerCase();
    const options = name.split(';').slice(1);
    if (options.some(o => o.toLowerCase() === 'binary')) return true;
    if (BINARY_ATTRIBUTES.has(base)) return true;
    const syntax = this.getAttributeSyntax(base);
    return syntax ? BINARY_SYNTAXES.has(syntax) : false;
  }

  /**
   * Collect the mandatory and optional attributes of a set of object classes,
   * walking every `SUP` chain.
   *
   * @param objectClasses object class names carried by an entry
   * @returns deduplicated `must` and `may` attribute names, `may` excluding
   *          anything already mandatory
   */
  resolveAttributes(objectClasses: string[]): {
    must: string[];
    may: string[];
  } {
    const must = new Set<string>();
    const may = new Set<string>();
    const visited = new Set<string>();

    const walk = (name: string): void => {
      const key = name.toLowerCase();
      if (visited.has(key)) return;
      visited.add(key);
      const oc = this.getObjectClass(name);
      if (!oc) return;
      oc.must.forEach(a => must.add(a));
      oc.may.forEach(a => may.add(a));
      oc.sup.forEach(walk);
    };
    objectClasses.forEach(walk);

    // An attribute that is mandatory somewhere is not optional
    for (const attribute of must) {
      for (const candidate of may) {
        if (candidate.toLowerCase() === attribute.toLowerCase())
          may.delete(candidate);
      }
    }
    return { must: [...must], may: [...may] };
  }
}
