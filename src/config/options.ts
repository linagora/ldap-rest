/**
 * Configuration options declared by the code that reads them.
 *
 * A plugin describes its options next to its implementation with
 * {@link defineOptions}; `src/config/args.ts` concatenates the declarations so
 * the parser sees the same entries it always did. {@link readOptions} gives a
 * plugin typed values, with the defaults applied and the value checked once.
 *
 * See `docs/plugin-development/options.md`.
 */
import {
  parseNumber,
  splitValue,
  type ArrayKind,
  type ConfigEntry,
  type ConfigTemplate,
} from '../lib/parseConfig';

import type { Config } from './args';

export type OptionType = 'string' | 'number' | 'boolean' | 'array' | 'json';

export interface OptionSpec<T> {
  readonly type: OptionType;
  /** Environment variable the option reads when the CLI does not set it */
  readonly env?: string;
  /** Value kept when neither the CLI nor the environment sets the option */
  readonly default?: T;
  /** Refuse an empty value rather than read it as unset */
  readonly required?: boolean;
  /**
   * A string option whose empty value means something: keep it instead of
   * reading the declared default, as an empty environment or CLI value does.
   */
  readonly emptyIsValue?: boolean;
  /**
   * Former CLI names still accepted, without the leading `--`: the parser
   * reads them as the canonical name and warns at startup. An alias takes one
   * value per occurrence, as the singular form does.
   */
  readonly aliases?: readonly string[];
  /**
   * Former environment variables still accepted, read when `env` is unset or
   * holds an empty value the type reads as nothing
   */
  readonly envAliases?: readonly string[];
}

export interface StringOption extends OptionSpec<string> {
  readonly type: 'string';
  /** Values the option accepts, when it is a closed set */
  readonly choices?: readonly string[];
}

export interface StringOrFalseOption extends OptionSpec<string | false> {
  readonly type: 'string';
  readonly allowFalse: true;
}

export interface NumberOption extends OptionSpec<number> {
  readonly type: 'number';
  readonly min?: number;
  readonly max?: number;
}

export interface BooleanOption extends OptionSpec<boolean> {
  readonly type: 'boolean';
}

export interface ArrayOption extends OptionSpec<string[]> {
  readonly type: 'array';
  /** CLI name of the plural form, without the leading `--` */
  readonly plural?: string;
  /** How a comma, space or semicolon separated value splits, see ArrayKind */
  readonly kind?: ArrayKind;
}

export interface JsonOption<T> extends OptionSpec<T> {
  readonly type: 'json';
}

export type OptionSet = Record<string, OptionSpec<unknown>>;

/** The typed values {@link readOptions} returns for a set of declarations */
export type OptionsOf<T extends OptionSet> = {
  [K in keyof T]: T[K] extends OptionSpec<infer V> ? V : never;
};

/**
 * A set of options, keyed by their `Config` name (`scim_max_results` for
 * `--scim-max-results`). Identity function: its only job is to keep the
 * literal types of the declarations.
 */
export function defineOptions<T extends OptionSet>(options: T): T {
  return options;
}

export const opt = {
  string: (options: Omit<StringOption, 'type'> = {}): StringOption => ({
    type: 'string',
    ...options,
  }),
  number: (options: Omit<NumberOption, 'type'> = {}): NumberOption => ({
    type: 'number',
    ...options,
  }),
  boolean: (options: Omit<BooleanOption, 'type'> = {}): BooleanOption => ({
    type: 'boolean',
    ...options,
  }),
  array: (options: Omit<ArrayOption, 'type'> = {}): ArrayOption => ({
    type: 'array',
    ...options,
  }),
  stringOrFalse: (
    options: Omit<StringOrFalseOption, 'type' | 'allowFalse'> = {}
  ): StringOrFalseOption => ({
    type: 'string',
    allowFalse: true,
    ...options,
  }),
  json: <T = Record<string, unknown>>(
    options: Omit<JsonOption<T>, 'type'> = {}
  ): JsonOption<T> => ({ type: 'json', ...options }),
};

/** CLI name of an option: `scim_max_results` is `--scim-max-results` */
function cliName(key: string): string {
  return `--${key.replace(/_/g, '-')}`;
}

/** The `Config` key an unknown `--name` reaches the parser's result under */
function cliKey(name: string): string {
  return name.replace(/^--?/, '').replace(/-/g, '_');
}

function emptyValue(type: OptionType): unknown {
  switch (type) {
    case 'boolean':
      return false;
    case 'number':
      return 0;
    case 'array':
      return [];
    case 'json':
      return {};
    default:
      return '';
  }
}

/**
 * The parser entries a set of declarations amounts to. `args.ts` concatenates
 * them with the global options and the other plugins' declarations.
 */
export function toConfigEntries(options: OptionSet): ConfigEntry[] {
  return Object.entries(options).map(([key, spec]) => {
    const value =
      spec.default === undefined ? emptyValue(spec.type) : spec.default;
    const array = spec as ArrayOption;
    const plural = array.plural
      ? array.plural.startsWith('--')
        ? array.plural
        : `--${array.plural}`
      : undefined;
    const aliases = spec.aliases?.map(alias =>
      alias.startsWith('--') ? alias : `--${alias}`
    );
    const entry: ConfigEntry = [
      cliName(key),
      spec.env ?? '',
      value as ConfigEntry[2],
      spec.type,
      plural,
      array.kind,
      Boolean(spec.required),
    ];
    if (aliases?.length) {
      entry[7] = aliases;
      if (spec.envAliases?.length) entry[8] = [...spec.envAliases];
    } else if (spec.envAliases?.length) {
      entry[8] = [...spec.envAliases];
    }
    return entry;
  });
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function checkNumber(name: string, spec: NumberOption, value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(
      `Option ${name} must be an integer, got "${String(value)}"`
    );
  if (spec.min !== undefined && value < spec.min)
    throw new Error(
      `Option ${name} must be at least ${spec.min}, got ${value}`
    );
  if (spec.max !== undefined && value > spec.max)
    throw new Error(`Option ${name} must be at most ${spec.max}, got ${value}`);
}

function checkValue(
  key: string,
  spec: OptionSpec<unknown>,
  value: unknown
): void {
  const name = cliName(key);
  if (spec.required && empty(value))
    throw new Error(`Option ${name} is required`);
  switch (spec.type) {
    case 'string':
      if (
        typeof value !== 'string' &&
        !(value === false && (spec as StringOrFalseOption).allowFalse)
      )
        throw new Error(`Option ${name} must be a string`);
      if (
        typeof value === 'string' &&
        (spec as StringOption).choices &&
        !(spec as StringOption).choices?.includes(value)
      )
        throw new Error(
          `Option ${name} must be one of ` +
            (spec as StringOption).choices?.join(', ')
        );
      break;
    case 'number':
      checkNumber(name, spec as NumberOption, value);
      break;
    case 'boolean':
      if (typeof value !== 'boolean')
        throw new Error(`Option ${name} must be true or false`);
      break;
    case 'array':
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
        throw new Error(`Option ${name} must be a list of strings`);
      break;
    case 'json':
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`Option ${name} must be a JSON object`);
      break;
  }
}

/**
 * `DM_*` variables no declared option reads. Test-only variables are left
 * out: a suite sets its own infrastructure through the same prefix.
 */
export function unknownEnvironmentOptions(
  entries: ConfigTemplate,
  env: Record<string, string | undefined> = process.env,
  extra: OptionSet[] = []
): string[] {
  const known = new Set(
    entries
      .flatMap(entry => [entry[1], ...(entry[8] ?? [])])
      .filter((name): name is string => Boolean(name))
  );
  for (const definitions of extra)
    for (const spec of Object.values(definitions))
      for (const name of [spec.env, ...(spec.envAliases ?? [])])
        if (name) known.add(name);
  return Object.keys(env).filter(
    name =>
      name.startsWith('DM_') && !name.startsWith('DM_TEST_') && !known.has(name)
  );
}

function valueFromEnvironment(
  key: string,
  spec: OptionSpec<unknown>,
  raw: string
): unknown {
  if (spec.type === 'array') {
    const items = splitValue(raw, (spec as ArrayOption).kind, 'plural');
    return items.length > 0 ? items : undefined;
  }
  if (spec.type === 'number') {
    if (!raw.trim()) return undefined;
    const number = parseNumber(raw);
    if (Number.isNaN(number))
      throw new Error(
        `Option ${key}: environment value "${raw}" is not a number`
      );
    return number;
  }
  if (spec.type === 'boolean') return raw.toLowerCase() === 'true';
  if (spec.type === 'json') {
    if (!raw.trim()) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `Option ${key}: environment value is not JSON: ${String(error)}`
      );
    }
  }
  return raw;
}

/** Whether a variable value counts as set for an option, as the parser reads it */
function environmentIsSet(
  spec: OptionSpec<unknown>,
  value: string | undefined
): boolean {
  if (value === undefined) return false;
  if (spec.type === 'number' || spec.type === 'json')
    return value.trim() !== '';
  if (spec.type === 'array')
    return splitValue(value, (spec as ArrayOption).kind, 'plural').length > 0;
  return true;
}

/** Deprecation messages already logged, so a plugin reading twice warns once */
const reportedWarnings = new Set<string>();

function reportWarning(
  warn: ((message: string) => void) | undefined,
  message: string
): void {
  if (!warn || reportedWarnings.has(message)) return;
  reportedWarnings.add(message);
  warn(message);
}

/**
 * Read a plugin's options from a parsed configuration, applying the declared
 * defaults and checking the values. Called once per instance by
 * `DmPlugin.options()`.
 *
 * `parsedKeys` names the options the parser knew. An option declared outside
 * `src/config/args.ts` reaches the parser as an unknown `--name value` pair,
 * so its aliases are read here, under the key the unknown name produces.
 */
export function readOptions<T extends OptionSet>(
  options: T,
  config: Config | Record<string, unknown>,
  parsedKeys: ReadonlySet<string> = new Set(),
  warn?: (message: string) => void
): OptionsOf<T> {
  const source = config as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(options)) {
    const envNames = [spec.env, ...(spec.envAliases ?? [])].filter(
      (name): name is string =>
        name !== undefined && environmentIsSet(spec, process.env[name])
    );
    const envName = envNames[0];
    const envAlias = envName !== undefined && envName !== spec.env;
    const cliAlias =
      !parsedKeys.has(key) && !(key in source)
        ? (spec.aliases ?? []).find(alias => cliKey(alias) in source)
        : undefined;
    const fromSource = key in source || cliAlias !== undefined;
    const configured = fromSource
      ? (source[key] ??
        (cliAlias === undefined ? undefined : source[cliKey(cliAlias)]))
      : !parsedKeys.has(key) && envName
        ? valueFromEnvironment(key, spec, process.env[envName] as string)
        : undefined;
    if (cliAlias !== undefined)
      reportWarning(
        warn,
        `Configuration: ${
          cliAlias.startsWith('--') ? cliAlias : `--${cliAlias}`
        } is deprecated, use ${cliName(key)}`
      );
    if (envAlias && envName !== undefined && !fromSource)
      reportWarning(
        warn,
        `Configuration: ${envName} is deprecated, use ${
          spec.env ?? cliName(key)
        }`
      );
    const emptyString =
      spec.type === 'string' &&
      !spec.emptyIsValue &&
      configured === '' &&
      spec.default !== undefined &&
      spec.default !== '';
    const value =
      configured === undefined || emptyString
        ? spec.default === undefined
          ? emptyValue(spec.type)
          : Array.isArray(spec.default)
            ? (spec.default as unknown[]).slice()
            : spec.default
        : Array.isArray(configured)
          ? (configured as unknown[]).slice()
          : configured;
    checkValue(key, spec, value);
    result[key] = value;
  }
  return result as OptionsOf<T>;
}
