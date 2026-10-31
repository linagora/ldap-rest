#!/usr/bin/env tsx
/**
 * Compare the options and the REST API a branch publishes with its base.
 *
 * See docs/development/contracts.md.
 *
 * Usage: npx tsx scripts/contracts.ts --base origin/master [--breaking]
 */
import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { OpenAPIGenerator } from './generate-openapi';
import {
  buildOptionsSnapshot,
  diffOptionsSnapshot,
  nonAdditive,
  type ContractDifference,
  type OptionSnapshot,
} from './options-snapshot';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const OPTIONS_SNAPSHOT = 'docs/usage/options.snapshot.json';
export const OPENAPI_SNAPSHOT = 'openapi.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

interface Operation {
  parameters?: Schema[];
  requestBody?: Schema;
  responses?: Record<string, Schema>;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, Schema>;
    parameters?: Record<string, Schema>;
    requestBodies?: Record<string, Schema>;
  };
}

/** A `$ref` target in a document, or the value itself */
function dereference<T>(
  value: T | undefined,
  document: OpenApiDocument
): T | undefined {
  const reference = (value as Schema | undefined)?.$ref as string | undefined;
  if (!reference) return value;
  const [, kind, name] =
    /^#\/components\/([^/]+)\/([^/]+)$/.exec(reference) ?? [];
  if (!kind || !name) return value;
  const components = document.components as Record<
    string,
    Record<string, T> | undefined
  >;
  return components?.[kind]?.[name] ?? value;
}

interface Shape {
  type?: string;
  format?: string;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean | number;
  exclusiveMaximum?: boolean | number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  enum?: unknown[];
  items?: Shape;
  properties?: Record<string, Shape>;
  required?: string[];
  additionalProperties?: boolean | Shape;
  oneOf?: Shape[];
  anyOf?: Shape[];
  allOf?: Shape[];
}

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

/** A schema reduced to what a client depends on: types, fields, required */
export function shapeOf(
  schema: Schema | undefined,
  document: OpenApiDocument,
  stack: string[] = []
): Shape {
  if (!schema) return {};
  const reference = schema.$ref as string | undefined;
  if (reference) {
    const name = reference.replace(/^#\/components\/schemas\//, '');
    const target = document.components?.schemas?.[name];
    if (target && !stack.includes(name))
      return shapeOf(target, document, [...stack, name]);
    return { type: 'object' };
  }
  const shape: Shape = {};
  if (typeof schema.type === 'string') shape.type = schema.type;
  if (typeof schema.format === 'string') shape.format = schema.format;
  if (typeof schema.nullable === 'boolean') shape.nullable = schema.nullable;
  for (const name of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'pattern',
    'default',
  ] as const)
    if (schema[name] !== undefined) shape[name] = schema[name];
  if (Array.isArray(schema.enum))
    shape.enum = [...(schema.enum as unknown[])].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  if (schema.items)
    shape.items = shapeOf(schema.items as Schema, document, stack);
  if (schema.properties)
    shape.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Schema>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, property]) => [name, shapeOf(property, document, stack)])
    );
  if (Array.isArray(schema.required))
    shape.required = [...(schema.required as string[])].sort();
  if (typeof schema.additionalProperties === 'boolean')
    shape.additionalProperties = schema.additionalProperties;
  else if (schema.additionalProperties)
    shape.additionalProperties = shapeOf(
      schema.additionalProperties as Schema,
      document,
      stack
    );
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const value = schema[combinator] as Schema[] | undefined;
    if (Array.isArray(value))
      shape[combinator] = value.map(item => shapeOf(item, document, stack));
  }
  return shape;
}

/** Every operation of the document, keyed `GET /path`, path parameters included */
export function operations(document: OpenApiDocument): Map<string, Operation> {
  const found = new Map<string, Operation>();
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    const shared = (item.parameters as Schema[] | undefined) ?? [];
    for (const method of METHODS) {
      const operation = item[method] as Operation | undefined;
      if (!operation || typeof operation !== 'object') continue;
      found.set(`${method.toUpperCase()} ${route}`, {
        ...operation,
        parameters: [...shared, ...(operation.parameters ?? [])],
      });
    }
  }
  return found;
}

function mediaTypes(body: Schema | undefined): Record<string, Schema> {
  return (body?.content as Record<string, Schema> | undefined) ?? {};
}

function requestBodyChanges(
  key: string,
  base: Schema,
  current: Schema | undefined,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  if (!current) {
    differences.push({ kind: 'removed', what: `request body ${key}` });
    return differences;
  }
  if (base.required !== true && current.required === true)
    differences.push({
      kind: 'changed',
      what: `request body ${key}`,
      detail: 'required: false → true',
    });
  const before = mediaTypes(base);
  const after = mediaTypes(current);
  for (const [type, schema] of Object.entries(before)) {
    const now = after[type];
    if (!now) {
      differences.push({
        kind: 'removed',
        what: `request body ${key} ${type}`,
      });
      continue;
    }
    differences.push(
      ...shapeChanges(
        `${key} request ${type}`,
        shapeOf(schema.schema as Schema, baseDocument),
        shapeOf(now.schema as Schema, currentDocument),
        'request'
      )
    );
  }
  return differences;
}

function responseHeaderChanges(
  key: string,
  base: Record<string, Schema> | undefined,
  current: Record<string, Schema> | undefined,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  for (const [name, header] of Object.entries(base ?? {})) {
    const now = current?.[name];
    if (!now) {
      differences.push({
        kind: 'removed',
        what: `response header ${key} ${name}`,
      });
      continue;
    }
    if (header.required === true && now.required !== true)
      differences.push({
        kind: 'changed',
        what: `response header ${key} ${name}`,
        detail: 'required: true → false',
      });
    differences.push(
      ...shapeChanges(
        `response header ${key} ${name}`,
        shapeOf(header.schema as Schema, baseDocument),
        shapeOf(now.schema as Schema, currentDocument),
        'response'
      )
    );
  }
  return differences;
}

function responseChanges(
  key: string,
  base: Operation,
  current: Operation,
  baseDocument: OpenApiDocument,
  currentDocument: OpenApiDocument
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  for (const [status, response] of Object.entries(base.responses ?? {})) {
    const now = current.responses?.[status];
    if (!now) {
      differences.push({ kind: 'removed', what: `response ${key} ${status}` });
      continue;
    }
    differences.push(
      ...responseHeaderChanges(
        `${key} ${status}`,
        response.headers as Record<string, Schema> | undefined,
        now.headers as Record<string, Schema> | undefined,
        baseDocument,
        currentDocument
      )
    );
    const before = mediaTypes(response);
    const after = mediaTypes(now);
    for (const [type, schema] of Object.entries(before)) {
      const next = after[type];
      if (!next) {
        differences.push({
          kind: 'removed',
          what: `response ${key} ${status} ${type}`,
        });
        continue;
      }
      differences.push(
        ...shapeChanges(
          `${key} ${status} response ${type}`,
          shapeOf(schema.schema as Schema, baseDocument),
          shapeOf(next.schema as Schema, currentDocument),
          'response'
        )
      );
    }
  }
  return differences;
}

/**
 * What a change does to a schema. A request field a client sends cannot go
 * away or become required without breaking it; a response field it reads
 * cannot go away. A type change breaks either way.
 */
export function shapeChanges(
  where: string,
  base: Shape,
  current: Shape,
  direction: 'request' | 'response'
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  if (
    base.type !== undefined &&
    base.type !== current.type &&
    !current.oneOf &&
    !current.anyOf
  )
    differences.push({
      kind: 'changed',
      what: where,
      detail: `type: ${base.type} → ${current.type ?? 'none'}`,
    });
  if (base.format !== current.format && base.format !== undefined)
    differences.push({
      kind: 'changed',
      what: where,
      detail: `format: ${base.format} → ${current.format ?? 'none'}`,
    });
  else if (
    direction === 'request' &&
    base.format === undefined &&
    current.format
  )
    differences.push({
      kind: 'changed',
      what: where,
      detail: `format: none → ${current.format}`,
    });
  else if (direction === 'request' && base.type === undefined && current.type)
    differences.push({
      kind: 'changed',
      what: where,
      detail: `type: none → ${current.type}`,
    });
  else if (direction === 'request' && base.items === undefined && current.items)
    differences.push({
      kind: 'changed',
      what: where,
      detail: 'items added',
    });
  if (base.nullable !== current.nullable && base.nullable !== undefined)
    differences.push({
      kind: 'changed',
      what: where,
      detail: `nullable: ${String(base.nullable)} → ${String(current.nullable)}`,
    });
  for (const name of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'pattern',
    'default',
  ] as const) {
    const changed =
      base[name] !== undefined &&
      JSON.stringify(base[name]) !== JSON.stringify(current[name]);
    // A bound added to a request schema narrows what a client may send
    const added =
      direction === 'request' &&
      base[name] === undefined &&
      current[name] !== undefined;
    if (changed || added)
      differences.push({
        kind: 'changed',
        what: where,
        detail: `${name}: ${JSON.stringify(base[name])} → ${JSON.stringify(current[name])}`,
      });
  }
  if (
    base.additionalProperties === true &&
    current.additionalProperties !== true
  )
    differences.push({
      kind: 'changed',
      what: where,
      detail: 'additional properties no longer accepted',
    });
  else if (
    base.additionalProperties &&
    typeof base.additionalProperties === 'object' &&
    current.additionalProperties &&
    typeof current.additionalProperties === 'object'
  )
    differences.push(
      ...shapeChanges(
        `${where}{}`,
        base.additionalProperties,
        current.additionalProperties,
        direction
      )
    );

  if (base.items && current.items)
    differences.push(
      ...shapeChanges(`${where}[]`, base.items, current.items, direction)
    );
  else if (base.items && !current.items)
    differences.push({ kind: 'changed', what: where, detail: 'items removed' });

  const allowed = new Set(
    (current.enum ?? []).map(value => JSON.stringify(value))
  );
  for (const value of base.enum ?? [])
    if (!allowed.has(JSON.stringify(value)))
      differences.push({
        kind: 'changed',
        what: where,
        detail: `enum value ${JSON.stringify(value)} removed`,
      });

  const before = base.properties ?? {};
  const after = current.properties ?? {};
  for (const [name, property] of Object.entries(before)) {
    const now = after[name];
    if (!now) {
      differences.push({ kind: 'removed', what: `${where}.${name}` });
      continue;
    }
    differences.push(
      ...shapeChanges(`${where}.${name}`, property, now, direction)
    );
  }
  if (direction === 'request') {
    const was = base.required ?? [];
    for (const name of current.required ?? [])
      if (!was.includes(name))
        differences.push({
          kind: 'changed',
          what: `${where}.${name}`,
          detail: 'required: false → true',
        });
  } else {
    const now = current.required ?? [];
    for (const name of base.required ?? [])
      if (!now.includes(name))
        differences.push({
          kind: 'changed',
          what: `${where}.${name}`,
          detail: 'required: true → false',
        });
  }

  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const was = base[combinator];
    const now = current[combinator];
    if (!was) continue;
    if (!now) {
      differences.push({
        kind: 'changed',
        what: where,
        detail: `${combinator} removed`,
      });
      continue;
    }
    // An added variant widens what is accepted or answered; a removed one
    // takes away something a client relied on. Variants are matched by shape
    // first so that an additive edit inside one is compared field by field.
    const unmatchedCurrent = [...now];
    const unmatchedBase: Shape[] = [];
    for (const variant of was) {
      const index = unmatchedCurrent.findIndex(
        candidate => JSON.stringify(candidate) === JSON.stringify(variant)
      );
      if (index === -1) unmatchedBase.push(variant);
      else unmatchedCurrent.splice(index, 1);
    }
    if (unmatchedBase.length === unmatchedCurrent.length)
      for (let index = 0; index < unmatchedBase.length; index++)
        differences.push(
          ...shapeChanges(
            `${where} ${combinator}[${index}]`,
            unmatchedBase[index],
            unmatchedCurrent[index],
            direction
          )
        );
    else {
      for (const _variant of unmatchedBase)
        differences.push({
          kind: 'changed',
          what: where,
          detail: `${combinator} variant removed`,
        });
    }
  }
  return differences;
}

/** What a change does to the REST API contract, operation by operation */
export function diffOpenApi(
  base: OpenApiDocument,
  current: OpenApiDocument
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  const before = operations(base);
  const after = operations(current);

  for (const [key, baseOperation] of before) {
    const now = after.get(key);
    if (!now) {
      differences.push({ kind: 'removed', what: key });
      continue;
    }

    const params = new Map(
      (baseOperation.parameters ?? []).map(parameter => {
        const resolved = dereference(parameter, base) ?? parameter;
        return [`${resolved.in} ${resolved.name}`, resolved];
      })
    );
    const nowParams = new Map(
      (now.parameters ?? []).map(parameter => {
        const resolved = dereference(parameter, current) ?? parameter;
        return [`${resolved.in} ${resolved.name}`, resolved];
      })
    );
    for (const [name, parameter] of params) {
      const currentParameter = nowParams.get(name);
      if (!currentParameter) {
        differences.push({
          kind: 'removed',
          what: `parameter ${key} ${name}`,
        });
        continue;
      }
      if (parameter.required !== true && currentParameter.required === true)
        differences.push({
          kind: 'changed',
          what: `parameter ${key} ${name}`,
          detail: 'required: false → true',
        });
      differences.push(
        ...shapeChanges(
          `parameter ${key} ${name}`,
          shapeOf(parameter.schema as Schema, base),
          shapeOf(currentParameter.schema as Schema, current),
          'request'
        )
      );
    }
    for (const [name, parameter] of nowParams)
      if (!params.has(name) && parameter.required === true)
        differences.push({
          kind: 'changed',
          what: `parameter ${key} ${name}`,
          detail: 'required parameter added',
        });

    const baseBody = dereference(baseOperation.requestBody, base);
    const currentBody = dereference(now.requestBody, current);
    if (baseBody)
      differences.push(
        ...requestBodyChanges(key, baseBody, currentBody, base, current)
      );
    else if (currentBody?.required === true)
      differences.push({
        kind: 'changed',
        what: `request body ${key}`,
        detail: 'required request body added',
      });
    differences.push(
      ...responseChanges(key, baseOperation, now, base, current)
    );
  }

  for (const key of after.keys())
    if (!before.has(key)) differences.push({ kind: 'added', what: key });
  return differences;
}

function revisionExists(revision: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function gitShow(revision: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${revision}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

class UsageError extends Error {}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new UsageError(`${name} needs a revision`);
  return value;
}

async function main(): Promise<void> {
  const base = argument('--base') ?? 'origin/master';
  if (!revisionExists(base)) {
    console.error(
      `❌ Unknown base revision ${base}: pass an existing branch or commit to --base.`
    );
    process.exitCode = 1;
    return;
  }
  const breaking = process.argv.includes('--breaking');
  const differences: ContractDifference[] = [];

  const baseOptions = gitShow(base, OPTIONS_SNAPSHOT);
  if (baseOptions === null)
    console.log(
      `No ${OPTIONS_SNAPSHOT} in ${base}: introducing the options snapshot.`
    );
  else {
    const { default: configArgs } = (await import('../src/config/args')) as {
      default: Parameters<typeof buildOptionsSnapshot>[0];
    };
    differences.push(
      ...diffOptionsSnapshot(
        JSON.parse(baseOptions) as OptionSnapshot[],
        buildOptionsSnapshot(configArgs)
      )
    );
  }

  const baseOpenApi = gitShow(base, OPENAPI_SNAPSHOT);
  if (baseOpenApi === null)
    console.log(
      `No ${OPENAPI_SNAPSHOT} in ${base}: introducing the REST API snapshot.`
    );
  else {
    const generator = new OpenAPIGenerator(root);
    await generator.analyze();
    differences.push(
      ...diffOpenApi(
        JSON.parse(baseOpenApi) as OpenApiDocument,
        generator.generateSpec() as OpenApiDocument
      )
    );
  }

  const nonAdditiveChanges = nonAdditive(differences);
  for (const difference of differences) {
    const prefix = difference.kind === 'added' ? '+' : '−';
    console.log(
      `${prefix} ${difference.kind} ${difference.what}` +
        (difference.detail ? ` (${difference.detail})` : '')
    );
  }
  if (differences.length === 0) {
    console.log('No change to the published contracts.');
    return;
  }
  if (nonAdditiveChanges.length === 0) {
    console.log('Only additive changes: no published contract breaks.');
    return;
  }

  const summary = `${nonAdditiveChanges.length} non-additive change(s) to a published contract.`;
  if (breaking) {
    console.log(`${summary} The breaking label allows them.`);
    return;
  }
  console.error(
    `${summary} Label the pull request \`breaking\`, or keep the old name, ` +
      'route or field. See docs/development/contracts.md.'
  );
  process.exitCode = 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain())
  main().catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error('❌ Error:', error);
    process.exit(1);
  });
