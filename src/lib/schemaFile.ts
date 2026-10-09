/**
 * Read a JSON schema file, resolving the chain of files it `extends`
 * @module lib/schemaFile
 *
 * The rules are described in
 * docs/client-development/schemas/README.md#extending-a-schema
 */
import fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { Config } from '../bin';
import configArgs from '../config/args';

import { transformSchemas } from './utils';

/** Directory of the schemas shipped with LDAP-Rest, whatever --schemas-path says */
export const shippedSchemasPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'static',
  'schemas'
);

/** Prefix of an `extends` naming a shipped schema, as `ldap-rest:twake/users.json` */
export const SHIPPED_SCHEMA_PREFIX = 'ldap-rest:';

export interface SchemaFileOptions {
  /**
   * Configuration whose values replace the `__FOO_BAR__` placeholders, in
   * every file of the chain
   */
  config?: Config;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Apply `patch` on `base`: plain objects are merged key by key, `null`
 * deletes a key, anything else (arrays included) replaces the base value
 *
 * @param base value being extended, left untouched
 * @param patch value of the extending file
 * @returns the merged value
 */
export function mergeSchema(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = isPlainObject(base)
    ? { ...base }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    // Not an assignment: JSON.parse makes "__proto__" an ordinary key, and
    // assigning it would replace the prototype of the result.
    Object.defineProperty(merged, key, {
      value: mergeSchema(
        Object.prototype.hasOwnProperty.call(merged, key)
          ? merged[key]
          : undefined,
        value
      ),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return merged;
}

/**
 * Path of the file an `extends` names
 *
 * @param file file holding the `extends`
 * @param base its value
 * @returns absolute path, or relative to the current directory when `file` is
 */
export function resolveSchemaBase(file: string, base: string): string {
  if (!base.startsWith(SHIPPED_SCHEMA_PREFIX))
    return resolve(dirname(file), base);
  const path = resolve(
    shippedSchemasPath,
    base.slice(SHIPPED_SCHEMA_PREFIX.length)
  );
  const inside = relative(shippedSchemasPath, path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    throw new Error(`${file}: "${base}" is not a shipped schema`);
  return path;
}

/** The files of a chain, read from the extending one down to its last base */
class SchemaChain {
  private readonly files: string[] = [];
  private readonly realPaths: string[] = [];
  private readonly layers: unknown[] = [];

  constructor(private readonly options: SchemaFileOptions) {}

  /**
   * The error to throw when `file` cannot be read: the first file's own, so
   * that its caller still tells a missing file by its `code`
   */
  readError(file: string, err: unknown): Error {
    if (!this.files.length) return err as Error;
    return new Error(
      `${this.files[this.files.length - 1]} extends ${file}, which cannot be read: ${(err as Error).message}`
    );
  }

  /**
   * @param file path the file was read from
   * @param realPath the same, symbolic links resolved, to detect loops
   * @param raw its content
   * @returns the path of the file it extends, if any
   */
  add(file: string, realPath: string, raw: string): string | undefined {
    if (this.realPaths.includes(realPath))
      throw new Error(`"extends" loop: ${[...this.files, file].join(' -> ')}`);
    this.files.push(file);
    this.realPaths.push(realPath);
    const text = this.options.config
      ? transformSchemas(raw, this.options.config)
      : raw;
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`);
    }
    if (!isPlainObject(schema) || !('extends' in schema)) {
      this.layers.push(schema);
      return undefined;
    }
    const { extends: base, ...rest } = schema;
    if (typeof base !== 'string' || !base)
      throw new Error(`${file}: "extends" must be the path of a schema`);
    this.layers.push(rest);
    return resolveSchemaBase(file, base);
  }

  result(): unknown {
    return this.layers.reduceRight((base, patch) => mergeSchema(base, patch));
  }
}

/**
 * Read a schema file and the files it extends, synchronously
 *
 * @param file path of the schema
 * @param options see {@link SchemaFileOptions}
 * @returns the parsed schema, merged with its bases
 */
export function loadSchemaFile<T = unknown>(
  file: string,
  options: SchemaFileOptions = {}
): T {
  const chain = new SchemaChain(options);
  for (let next: string | undefined = file; next; ) {
    let raw: string;
    try {
      raw = fs.readFileSync(next, 'utf8');
    } catch (err) {
      throw chain.readError(next, err);
    }
    next = chain.add(next, fs.realpathSync(next), raw);
  }
  return chain.result() as T;
}

/**
 * Read a schema file and the files it extends
 *
 * @param file path of the schema
 * @param options see {@link SchemaFileOptions}
 * @returns the parsed schema, merged with its bases
 */
export async function loadSchemaFileAsync<T = unknown>(
  file: string,
  options: SchemaFileOptions = {}
): Promise<T> {
  const chain = new SchemaChain(options);
  for (let next: string | undefined = file; next; ) {
    let raw: string;
    try {
      raw = await fs.promises.readFile(next, 'utf8');
    } catch (err) {
      throw chain.readError(next, err);
    }
    next = chain.add(next, await fs.promises.realpath(next), raw);
  }
  return chain.result() as T;
}

/**
 * URL the static plugin serves a schema file at: its path from the first
 * `schemas` directory it is in, under --static-name
 *
 * @param config server configuration
 * @param file path of the schema
 * @returns the URL, or undefined when the path has no `schemas` directory
 */
export function schemaUrl(config: Config, file: string): string | undefined {
  const index = file.indexOf('/schemas/');
  if (index === -1) return undefined;
  return `/${config.static_name || 'static'}${file.substring(index)}`;
}

const schemaOptions: [keyof Config, string][] = [
  ['group_schema', '--group-schema'],
  ['organization_schema', '--organization-schema'],
  ['ldap_flat_schema', '--ldap-flat-schema'],
];

/**
 * The schema files the configuration names, those the plugins advertise a
 * {@link schemaUrl} for. A value left at its default is not one: the
 * default `--group-schema` lies in the package, and a `--static-path` of
 * the deployment's own keeps serving its file at that URL.
 *
 * @param config server configuration
 * @returns their paths, as configured
 */
export function configuredSchemaFiles(config: Config): string[] {
  const files: string[] = [];
  for (const [key, option] of schemaOptions) {
    const defaults = [configArgs.find(entry => entry[0] === option)?.[2]]
      .flat()
      .filter((file): file is string => typeof file === 'string' && !!file)
      .map(file => resolve(file));
    for (const file of [config[key]].flat())
      if (typeof file === 'string' && file && !defaults.includes(resolve(file)))
        files.push(file);
  }
  return files;
}
