/**
 * Client-side view of the directory schema: the lookups the UI needs to
 * annotate an entry (mandatory attributes, descriptions, binary values).
 *
 * This mirrors `src/lib/ldapSchema.ts` on the server, minus the parsing:
 * the browser receives the schema already parsed.
 *
 * @module browser/ldap-browser/schema
 */

import type {
  AttributeTypeDefinition,
  LdapSchema,
  ObjectClassDefinition,
} from './types';

/** Syntaxes whose values are octets rather than text */
const BINARY_SYNTAXES = new Set([
  '1.3.6.1.4.1.1466.115.121.1.5',
  '1.3.6.1.4.1.1466.115.121.1.8',
  '1.3.6.1.4.1.1466.115.121.1.9',
  '1.3.6.1.4.1.1466.115.121.1.10',
  '1.3.6.1.4.1.1466.115.121.1.28',
  '1.3.6.1.4.1.1466.115.121.1.40',
  '1.3.6.1.4.1.1466.115.121.1.49',
]);

/** Attributes whose values are images, previewed as such */
const IMAGE_ATTRIBUTES = new Set([
  'jpegphoto',
  'photo',
  'thumbnailphoto',
  'thumbnaillogo',
]);

export class SchemaView {
  readonly schema: LdapSchema;
  private objectClasses = new Map<string, ObjectClassDefinition>();
  private attributeTypes = new Map<string, AttributeTypeDefinition>();

  constructor(schema: LdapSchema) {
    this.schema = schema;
    for (const oc of schema.objectClasses) {
      this.objectClasses.set(oc.oid.toLowerCase(), oc);
      for (const name of oc.names)
        this.objectClasses.set(name.toLowerCase(), oc);
    }
    for (const at of schema.attributeTypes) {
      this.attributeTypes.set(at.oid.toLowerCase(), at);
      for (const name of at.names)
        this.attributeTypes.set(name.toLowerCase(), at);
    }
  }

  /**
   * Look up an object class by name or OID.
   *
   * @param name object class name or OID
   * @returns the definition, or undefined when unknown
   */
  getObjectClass(name: string): ObjectClassDefinition | undefined {
    return this.objectClasses.get(name.toLowerCase());
  }

  /**
   * Look up an attribute type by name or OID, ignoring attribute options.
   *
   * @param name attribute name, `;binary` and friends included
   * @returns the definition, or undefined when unknown
   */
  getAttributeType(name: string): AttributeTypeDefinition | undefined {
    return this.attributeTypes.get(name.split(';')[0].toLowerCase());
  }

  /**
   * Resolve the syntax of an attribute through its `SUP` chain.
   *
   * @param name attribute name
   * @returns syntax OID, or undefined
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
   * Tell whether an attribute is meant to be displayed as an image.
   *
   * @param name attribute name
   * @returns true for photo-like attributes
   */
  isImageAttribute(name: string): boolean {
    return IMAGE_ATTRIBUTES.has(name.split(';')[0].toLowerCase());
  }

  /**
   * Tell whether an attribute holds octets rather than text.
   *
   * @param name attribute name
   * @returns true when values are binary
   */
  isBinaryAttribute(name: string): boolean {
    if (
      name
        .split(';')
        .slice(1)
        .some(o => o.toLowerCase() === 'binary')
    )
      return true;
    const syntax = this.getAttributeSyntax(name);
    return syntax ? BINARY_SYNTAXES.has(syntax) : false;
  }

  /**
   * Collect the mandatory and optional attributes of a set of object
   * classes, walking every `SUP` chain.
   *
   * @param objectClasses object class names carried by an entry
   * @returns `must` and `may` attribute names, `may` excluding mandatory ones
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

    const mustLower = new Set([...must].map(a => a.toLowerCase()));
    return {
      must: [...must],
      may: [...may].filter(a => !mustLower.has(a.toLowerCase())),
    };
  }
}
