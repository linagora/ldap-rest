import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
} from '../ldapActions';
import { BadRequestError } from '../errors';
import type { Schema } from '../../config/schema';
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
   * Check a new entry, converted in place: what is checked is what the
   * directory gets.
   *
   * @param entry entry as the client sent it, `objectClass` included
   */
  async validateNew(entry: AttributesList): Promise<void> {
    toDirectoryEntry(this.schema, entry);
    if (!this.schema) return;

    // A fixed attribute with a default is checked at that default, not at
    // what was sent; `objectClass` is the entity's
    for (const [field, attr] of Object.entries(this.schema.attributes))
      if (attr.fixed && attr.default !== undefined && field !== 'objectClass')
        entry[field] = attr.default;

    for (const [field, value] of Object.entries(entry)) {
      const attr = schemaAttribute(this.schema, field)?.[1];
      if (!attr) {
        if (this.schema.strict)
          throw new BadRequestError(
            `Unknown attribute "${field}" for ${this.deps.singularName}`
          );
        continue;
      }
      // Before the value checks: an empty required value is missing, not
      // invalid
      if (attr.required && !value && !attr.generated)
        throw new BadRequestError(`Attribute "${field}" is required`);
      await this.validateValue(field, value);
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
  }

  /**
   * Check the parts of a change, converted in place.
   *
   * @param changes change as the client sent it
   */
  async validateChanges(changes: ModifyRequest): Promise<void> {
    toDirectoryChanges(this.schema, changes);
    if (!this.schema) return;

    for (const part of ['add', 'replace'] as const)
      for (const [field, value] of Object.entries(changes[part] ?? {})) {
        if (schemaAttribute(this.schema, field)?.[1]?.fixed)
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be modified`
          );
        await this.validateValue(field, value);
      }
    if (changes.delete) {
      const fields = Array.isArray(changes.delete)
        ? changes.delete
        : Object.keys(changes.delete);
      for (const field of fields)
        if (schemaAttribute(this.schema, field)?.[1]?.fixed)
          throw new BadRequestError(
            `Attribute "${field}" is fixed and cannot be deleted`
          );
    }
  }

  /**
   * Check one value against its attribute's rules.
   *
   * @param field attribute name, as the client wrote it
   * @param value value sent; no value clears the attribute
   */
  async validateValue(
    field: string,
    value: AttributeValue | null
  ): Promise<void> {
    if (!this.schema) return;
    const attr = schemaAttribute(this.schema, field)?.[1];
    const invalid = (): BadRequestError =>
      new BadRequestError(invalidValueMessage(field, attr));
    if (!attr) {
      if (this.schema.strict) throw invalid();
      return;
    }
    // No value clears the attribute. An empty string is a value, checked
    // against the pattern, and for a pointer against its branch
    if (value === null || value === undefined) return;
    // An empty list is no value either: a replace clears the attribute with it
    if (Array.isArray(value) && value.length === 0) {
      if (attr.required)
        throw new BadRequestError(`Attribute "${field}" is required`);
      return;
    }
    await checkDnValues(field, attr, value, this.deps.entryExists);
    if (!matchesPattern(attr, value)) throw invalid();
  }
}
