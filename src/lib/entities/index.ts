/**
 * The entity types a server serves: the flat entities, the groups and the
 * organizations, each with its branch, main attribute and schema.
 *
 * A plugin declares the entities it serves as it loads; a consumer reads the
 * registry instead of indexing `server.loadedPlugins`, so the core and the
 * plugin families no longer need to know which plugin holds which entity.
 *
 * @see docs/plugin-development/services.md
 */
import type { Request } from 'express';

import type { Schema } from '../../config/schema';
import type { ModifyRequest } from '../ldapActions';
import { serviceToken } from '../services';

/** What kind of entity a descriptor describes. */
export type EntityKind = 'flat' | 'groups' | 'organizations';

/**
 * The part of a plugin an entity descriptor reads: its branch and its schema.
 * The schema is read through the source, not copied, because a plugin may
 * load it asynchronously after it registers the entity.
 */
export interface EntitySource {
  readonly base?: string;
  readonly schema?: Schema;
}

/** The write path a flat entity offers to a plugin driving it. */
export interface FlatEntityApi {
  modifyEntry(
    id: string,
    changes: ModifyRequest,
    req: Request
  ): Promise<boolean>;
}

/** One entity type a server serves. */
export interface EntityDescriptor {
  /** Singular name, as the schema and the hooks name it */
  readonly name: string;
  /** Collection name, as the routes name it */
  readonly pluralName: string;
  /** Branch holding the entries */
  readonly base: string;
  /** Attribute holding an entry's identifier */
  readonly mainAttribute: string;
  readonly kind: EntityKind;
  /** The schema, when the entity declares one */
  readonly schema: Schema | undefined;
  /** The write path, for a flat entity */
  readonly flat?: FlatEntityApi;
}

/** What a plugin registers for one entity. */
export interface EntityDeclaration {
  name: string;
  pluralName: string;
  base: string;
  mainAttribute: string;
  kind: EntityKind;
  /** The plugin holding the schema, read live */
  source: EntitySource;
  /** The write path, for a flat entity */
  flat?: FlatEntityApi;
}

/** The entity types a server serves. */
export interface EntityRegistry {
  /**
   * Declare an entity. Registering the same kind and name again replaces the
   * previous declaration, so a plugin loaded twice under two names does not
   * list its entity twice.
   *
   * @param declaration the entity and the plugin holding its schema
   */
  register(declaration: EntityDeclaration): void;
  /** @returns every entity, in registration order */
  all(): readonly EntityDescriptor[];
  /**
   * @param kind the kind wanted
   * @returns the entities of that kind, in registration order
   */
  ofKind(kind: EntityKind): readonly EntityDescriptor[];
  /** @returns the schema of every entity, undefined for those without one */
  schemas(): readonly (Schema | undefined)[];
}

/** The service token consumers use to reach the registry. */
export const EntityRegistryService = serviceToken<EntityRegistry>('entities');

class Registry implements EntityRegistry {
  private readonly entities = new Map<string, EntityDescriptor>();

  register(declaration: EntityDeclaration): void {
    const { name, pluralName, base, mainAttribute, kind, source, flat } =
      declaration;
    this.entities.set(`${kind}:${name}`, {
      name,
      pluralName,
      base,
      mainAttribute,
      kind,
      flat,
      get schema() {
        return source.schema;
      },
    });
  }

  all(): readonly EntityDescriptor[] {
    return [...this.entities.values()];
  }

  ofKind(kind: EntityKind): readonly EntityDescriptor[] {
    return this.all().filter(entity => entity.kind === kind);
  }

  schemas(): readonly (Schema | undefined)[] {
    return this.all().map(entity => entity.schema);
  }
}

/** @returns an empty registry */
export const createEntityRegistry = (): EntityRegistry => new Registry();
