import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
} from '../ldapActions';
import { BadRequestError } from '../errors';
import { knownAttributeName } from '../utils';
import type { Schema, SchemaAttribute } from '../../config/schema';
import {
  checkDnValues,
  invalidValueMessage,
  matchesPattern,
  maxLengthOf,
  missingRequiredAttribute,
  schemaAttribute,
  toDirectoryChanges,
  toDirectoryEntry,
  tooLongMessage,
  tooLongValue,
} from '../../config/schema';

export interface EntityValidatorDeps {
  /**
   * Tells whether a DN names an entry. Asked as the server: a reference to
   * an entry the caller cannot read is still a valid reference.
   */
  entryExists: (dn: string) => Promise<boolean>;
  /** Asked whether a `generated` attribute will be filled after validation */
  loadedPlugins: Record<string, unknown>;
  /** Names the entity in the messages */
  singularName: string;
}

/**
 * Enforces an entity schema on what a client sends: the entry of a creation
 * and the parts of a change. Every refusal is a `BadRequestError`.
 *
 * See `docs/client-development/schemas/README.md` for the rules.
 */
export class EntityValidator {
  constructor(
    private readonly schema: Schema | undefined,
    private readonly deps: EntityValidatorDeps
  ) {}

  /**
   * Check a new entry, then convert it for the directory. Every attribute
   * the schema declares is named as the schema does, a form the defaults,
   * the required check and the conversion all read.
   *
   * @param entry entry as the client sent it, `objectClass` included
   * @returns the entry to write: the one given, or a copy under the schema's
   *   spellings
   */
  async validateNew(entry: AttributesList): Promise<AttributesList> {
    const candidate = this.renameDeclared(entry);
    this.dropUndeclaredEmpty(candidate);
    if (!this.schema) {
      toDirectoryEntry(undefined, candidate);
      return candidate;
    }
    // Checked at the default, not at what was sent
    applyFixedDefaults(this.schema, candidate);

    await this.checkValues(candidate);
    // A `generated` attribute is exempt only when something will fill it,
    // see `missingRequiredAttribute`
    const missing = missingRequiredAttribute(
      this.schema,
      candidate,
      this.deps.loadedPlugins
    );
    if (missing)
      throw new BadRequestError(`Attribute "${missing}" is required`);
    toDirectoryEntry(this.schema, candidate);
    return candidate;
  }

  /**
   * Check the parts of a change, then convert them. Under a name the schema
   * declares, no value becomes the empty list, which clears the attribute
   * in a `replace` and is refused in an `add`; under a name it does not
   * declare, a `null` is dropped from an `add` and becomes that empty list
   * in a `replace`.
   *
   * @param changes change as the client sent it
   * @returns the same change, under the schema's spellings
   */
  async validateChanges(changes: ModifyRequest): Promise<ModifyRequest> {
    // Every part before any check: what one names, another may give a value
    changes.add = changes.add && this.renameDeclared(changes.add);
    changes.replace = changes.replace && this.renameDeclared(changes.replace);
    if (changes.delete)
      changes.delete = Array.isArray(changes.delete)
        ? this.renameDeclaredNames(changes.delete)
        : this.renameDeclared(changes.delete);
    for (const part of ['add', 'replace'] as const) {
      const values = changes[part];
      if (!values) continue;
      if (part === 'add') this.dropUndeclaredEmpty(values);
      await this.checkValues(values, part);
    }
    if (!this.schema) {
      toDirectoryChanges(undefined, changes);
      return changes;
    }
    if (changes.delete) {
      const fields = Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete);
      for (const field of fields) {
        const attr = this.attribute(field);
        if (attr?.fixed)
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be deleted`
          );
        if (attr?.required && this.deletesWhole(changes, field))
          throw new BadRequestError(`Attribute "${field}" is required`);
      }
    }
    toDirectoryChanges(this.schema, changes);
    return changes;
  }

  /**
   * Whether a change removes every value of an attribute: a `delete` naming
   * it, in the list or under a name with no value as the directory layer
   * reads it, and nothing in the same change giving it a value again, in an
   * `add` or a `replace` that the directory applies after the `delete`. A
   * `delete` naming some values leaves the others.
   */
  private deletesWhole(changes: ModifyRequest, field: string): boolean {
    const deletePart = changes.delete as string[] | AttributesList;
    const named = Array.isArray(deletePart) ? undefined : deletePart[field];
    // An empty list clears the attribute, as a name alone does
    if (Array.isArray(named) && named.length > 0) return false;
    const base = field.split(';')[0].toLowerCase();
    return ![changes.add, changes.replace].some(part =>
      Object.entries(part ?? {}).some(
        ([key, value]) =>
          key.split(';')[0].toLowerCase() === base && !isNoValue(value)
      )
    );
  }

  /**
   * Name every key the schema declares as the schema does, and refuse two
   * keys naming one attribute. The conversion, the required check and the
   * defaults look a declared attribute up by its own name: a field they
   * would leave out is one the client sent under another case or with a
   * `;binary` option.
   *
   * @returns the same attributes, renamed: the map itself when nothing
   *   changes, a copy renamed otherwise
   * @throws BadRequestError when two keys name the same attribute
   */
  private renameDeclared(values: AttributesList): AttributesList {
    const keys = Object.keys(values);
    const names = this.renameDeclaredNames(keys);
    if (keys.every((key, i) => key === names[i])) return values;
    // A new object rather than deletes and assignments: the keys are copied
    // from JSON, `__proto__` among them, and assigning that one would set
    // the prototype instead
    const renamed: AttributesList = Object.create(null) as AttributesList;
    for (const [i, name] of names.entries()) renamed[name] = values[keys[i]];
    return renamed;
  }

  /**
   * {@link renameDeclared} on a list of names, such as a `delete`.
   *
   * Two names of one attribute are refused as the routes refuse them: as
   * the schema declares it, or as this server knows the attribute by its
   * name, which makes `l;binary` and `L` one attribute.
   */
  private renameDeclaredNames(keys: string[]): string[] {
    const seen = new Map<string, string>();
    return keys.map(key => {
      const id = this.attributeIdentity(key);
      const same = seen.get(id);
      if (same !== undefined && same !== key)
        throw new BadRequestError(
          `"${same}" and "${key}" name the same attribute`
        );
      seen.set(id, key);
      return this.schemaSpelling(key);
    });
  }

  /**
   * The attribute a name holds, case and option aside: the option is a
   * transfer syntax, and `l;binary` is the `l` a plain `L` names.
   */
  private attributeIdentity(field: string): string {
    const base = split(field)[0];
    return (
      schemaAttribute(this.schema, base)?.[0] ??
      knownAttributeName(base) ??
      base
    ).toLowerCase();
  }

  /**
   * The schema's spelling of a declared attribute, with the `;binary`
   * option, the only one a write takes, written as the directory writes it.
   */
  private schemaSpelling(field: string): string {
    const [base, option] = split(field);
    const named = schemaAttribute(this.schema, base)?.[0];
    if (named === undefined) return field;
    return option ? `${named};${option}` : named;
  }

  /**
   * Drop, in place, the keys a creation or an `add` carries with `null` or
   * `undefined` under a name the schema does not declare. A declared
   * attribute is left to the schema, which turns no value into the empty
   * list, refused for a `required` one; an undeclared one has no such step,
   * and without a schema none exists. The write would otherwise carry
   * `[null]`, which ldapts cannot send.
   */
  private dropUndeclaredEmpty(values: AttributesList): void {
    for (const [field, value] of Object.entries(values))
      if (
        (value === null || value === undefined) &&
        // `attribute` refuses an undeclared name, so a strict schema still
        // answers 400 here rather than losing the key to a drop
        !this.attribute(field)
      )
        delete values[field];
  }

  /**
   * Check every value of a creation or of a part of a change, then write the
   * shape each one is stored in, in place: no value becomes the empty list,
   * which clears the attribute in a `replace`. A value the schema does not
   * declare is left as sent on a change, and on a creation as the directory
   * layer takes it.
   *
   * @param values entry of a creation, or `add` / `replace` of a change
   * @param part the part of a change, undefined for a creation
   */
  private async checkValues(
    values: AttributesList,
    part?: 'add' | 'replace'
  ): Promise<void> {
    for (const [field, value] of Object.entries(values)) {
      const attr = this.attribute(field);
      if (attr?.fixed && part)
        throw new BadRequestError(
          `Attribute "${field}" is fixed and cannot be modified`
        );
      // Before the value checks: an empty required value is missing, not
      // invalid
      if (attr?.required && !part && isMissing(value) && !attr.generated)
        throw new BadRequestError(`Attribute "${field}" is required`);
      if (attr || part)
        values[field] = asStored(await this.validateValue(field, value));
    }
  }

  /**
   * Check one value against its attribute's rules: its shape, then the
   * entries a pointer names, then the pattern.
   *
   * @param field attribute name, as the client wrote it
   * @param value value sent; no value clears the attribute
   * @returns the value in the shape of the type: one value for a
   *   single-valued attribute, a list for an `array`
   */
  async validateValue(
    field: string,
    value: AttributeValue | null | undefined
  ): Promise<AttributeValue | null | undefined> {
    if (!this.schema) return value;
    const attr = this.attribute(field);
    if (!attr) return value;
    // No value clears the attribute. An empty string is a value: checked
    // against the pattern, refused as an empty DN for a pointer
    if (isNoValue(value)) {
      if (attr.required)
        throw new BadRequestError(`Attribute "${field}" is required`);
      return value;
    }
    // A list of one value is that value and one value a list of one: what a
    // read answers for one value can be sent back as is
    let shaped: AttributeValue = value;
    if (attr.type === 'array') {
      if (!Array.isArray(value)) shaped = [value] as AttributeValue;
      for (const item of shaped as unknown[])
        assertScalar(field, item, attr.items?.type);
    } else {
      if (Array.isArray(value)) {
        if (value.length > 1)
          throw new BadRequestError(
            `Attribute "${field}" must be a single value`
          );
        shaped = value[0];
      }
      // A normalised value may arrive as text (`5GB`), read after this
      if (!(attr.normalize && typeof shaped === 'string'))
        assertScalar(field, shaped, attr.type);
    }
    // Before the lookups: a pointer is not searched for, nor a DN asked to the
    // directory, when the value is too long to be kept anyway
    if (tooLongValue(attr, shaped) !== undefined)
      throw new BadRequestError(tooLongMessage(field, maxLengthOf(attr)));
    await checkDnValues(field, attr, shaped, this.deps.entryExists);
    if (!matchesPattern(attr, shaped))
      throw new BadRequestError(invalidValueMessage(field, attr));
    return shaped;
  }

  /**
   * The schema's definition of an attribute, under any case.
   *
   * @throws BadRequestError for a name a strict schema does not declare
   */
  private attribute(field: string): SchemaAttribute | undefined {
    const attr = schemaAttribute(this.schema, field)?.[1];
    if (!attr && this.schema?.strict)
      throw new BadRequestError(
        `Unknown attribute "${field}" for ${this.deps.singularName}`
      );
    return attr;
  }
}

/**
 * Write every fixed attribute with a default as the schema says, whatever
 * the request carried. `objectClass` is left to the entity's configuration.
 * Run on the entry an authorization judges, so that it judges the entry
 * written.
 *
 * @param schema entity schema, nothing to apply without one
 * @param entry entry about to be created, changed in place
 */
export function applyFixedDefaults(
  schema: Schema | undefined,
  entry: AttributesList
): void {
  if (!schema) return;
  for (const [field, attr] of Object.entries(schema.attributes))
    if (
      attr.fixed &&
      attr.default !== undefined &&
      field.toLowerCase() !== 'objectclass'
    )
      entry[field] = attr.default;
}

/**
 * An attribute description split between its type and its option, the
 * latter lowercased: options are case-insensitive, and `;binary` is the only
 * one a write takes.
 */
const split = (field: string): [string, string | undefined] => {
  const [base, ...options] = field.split(';');
  return [base, options.find(Boolean)?.toLowerCase()];
};

/** No value: what clears an attribute in a `replace` */
const isNoValue = (value: unknown): value is null | undefined | [] =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0);

/** What leaves a required attribute missing, an empty string included */
const isMissing = (value: unknown): boolean => isNoValue(value) || value === '';

/** The directory layer reads no value as the empty list, never as `null` */
const asStored = (value: AttributeValue | null | undefined): AttributeValue =>
  isNoValue(value) ? [] : value;

const NUMBER = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/**
 * Refuse a value the attribute's type cannot hold. A number may arrive as
 * text, a boolean as the directory's `TRUE` / `FALSE`. A JSON number is
 * judged on the text `String` writes for it, what the directory is sent, so
 * that a value is accepted or refused like that text.
 */
function assertScalar(field: string, value: unknown, type?: string): void {
  // `String` writes an exponent, which neither NUMBER nor INTEGER reads,
  // outside `[1e-6, 1e21)`: `1e21` is written `1e+21`, `1e-7` as `1e-7`.
  // Beyond 2^53 the JSON parser has already lost the digits
  const written =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : undefined;
  const reads = (pattern: RegExp): boolean =>
    written !== undefined
      ? pattern.test(written)
      : typeof value === 'string' && pattern.test(value);
  const ok = (): boolean => {
    switch (type) {
      case 'number':
        return (
          reads(NUMBER) &&
          (typeof value !== 'number' ||
            !Number.isInteger(value) ||
            Number.isSafeInteger(value))
        );
      case 'integer':
        return (
          reads(INTEGER) &&
          (typeof value !== 'number' || Number.isSafeInteger(value))
        );
      case 'boolean':
        return (
          typeof value === 'boolean' ||
          (typeof value === 'string' && (value === 'TRUE' || value === 'FALSE'))
        );
      default:
        return typeof value === 'string' || Buffer.isBuffer(value);
    }
  };
  if (!ok()) {
    const expected =
      type === 'number' || type === 'integer' || type === 'boolean'
        ? `a${type === 'integer' ? 'n' : ''} ${type}`
        : 'a string';
    throw new BadRequestError(`Attribute "${field}" must be ${expected}`);
  }
}
