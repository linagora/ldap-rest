import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
} from '../ldapActions';
import { BadRequestError } from '../errors';
import type { Schema, SchemaAttribute } from '../../config/schema';
import {
  checkDnValues,
  invalidValueMessage,
  matchesPattern,
  missingRequiredAttribute,
  schemaAttribute,
  toDirectoryChanges,
  toDirectoryEntry,
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
   * Check a new entry, then convert it in place for the directory.
   *
   * @param entry entry as the client sent it, `objectClass` included
   */
  async validateNew(entry: AttributesList): Promise<void> {
    if (!this.schema) {
      toDirectoryEntry(undefined, entry);
      return;
    }
    // A fixed attribute with a default is checked at that default, not at
    // what was sent; `objectClass` is the entity's
    for (const [field, attr] of Object.entries(this.schema.attributes))
      if (attr.fixed && attr.default !== undefined && field !== 'objectClass')
        entry[field] = attr.default;

    for (const [field, value] of Object.entries(entry)) {
      const attr = this.attribute(field);
      if (!attr) continue;
      // Before the value checks: an empty required value is missing, not
      // invalid
      if (attr.required && isMissing(value) && !attr.generated)
        throw new BadRequestError(`Attribute "${field}" is required`);
      entry[field] = asStored(await this.validateValue(field, value));
    }
    // A `generated` attribute is exempt only when something will fill it,
    // see `missingRequiredAttribute`
    const missing = missingRequiredAttribute(
      this.schema,
      entry,
      this.deps.loadedPlugins
    );
    if (missing)
      throw new BadRequestError(`Attribute "${missing}" is required`);
    toDirectoryEntry(this.schema, entry);
  }

  /**
   * Check the parts of a change, then convert them in place. No value under
   * a name clears the attribute: `null` becomes the empty list the directory
   * layer reads so.
   *
   * @param changes change as the client sent it
   */
  async validateChanges(changes: ModifyRequest): Promise<void> {
    if (!this.schema) {
      toDirectoryChanges(undefined, changes);
      return;
    }
    for (const part of ['add', 'replace'] as const) {
      const values = changes[part];
      if (!values) continue;
      for (const [field, value] of Object.entries(values)) {
        if (this.attribute(field)?.fixed)
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be modified`
          );
        values[field] = asStored(await this.validateValue(field, value));
      }
    }
    if (changes.delete) {
      // Named by itself, a required attribute would be left missing; named
      // with values, some may remain
      const byName = Array.isArray(changes.delete);
      const fields = byName
        ? (changes.delete as string[])
        : Object.keys(changes.delete);
      for (const field of fields) {
        const attr = this.attribute(field);
        if (attr?.fixed)
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be deleted`
          );
        if (byName && attr?.required)
          throw new BadRequestError(`Attribute "${field}" is required`);
      }
    }
    toDirectoryChanges(this.schema, changes);
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

/** No value: clears an attribute in a change, leaves it out of a creation */
const isNoValue = (value: unknown): value is null | undefined | [] =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0);

/** What leaves a required attribute missing, an empty string included */
const isMissing = (value: unknown): boolean => isNoValue(value) || value === '';

/** No value is the empty list for the directory layer, never `null` */
const asStored = (value: AttributeValue | null | undefined): AttributeValue =>
  isNoValue(value) ? [] : value;

const NUMBER = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/**
 * Refuse a value the attribute's type cannot hold. A number may arrive as
 * text, a boolean as the directory's `TRUE` / `FALSE`.
 */
function assertScalar(field: string, value: unknown, type?: string): void {
  const text = typeof value === 'string';
  const ok = (): boolean => {
    switch (type) {
      case 'number':
        return (
          (typeof value === 'number' && Number.isFinite(value)) ||
          (text && NUMBER.test(value))
        );
      case 'integer':
        return (
          (typeof value === 'number' && Number.isInteger(value)) ||
          (text && INTEGER.test(value))
        );
      case 'boolean':
        return (
          typeof value === 'boolean' ||
          (text && (value === 'TRUE' || value === 'FALSE'))
        );
      default:
        return text || Buffer.isBuffer(value);
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
