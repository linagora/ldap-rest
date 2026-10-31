/**
 * Configuration parser
 * Order: default < env < cli
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Config } from '../config/args';

import type { AttributeValue } from './ldapActions';

export type ConfigTemplate = ConfigEntry[];

type ConfigResultValue =
  | string
  | string[]
  | boolean
  | number
  | Record<string, AttributeValue>
  | undefined;

// What an array option holds, which tells how its values split:
//  - identifiers (classes, attributes, plugins...): the singular form splits
//    on commas; the environment variable and the plural form split on `;` if
//    the value has one, else on `,`, and on spaces
//  - dns: a DN holds commas and spaces, so the singular form never splits and
//    the environment variable and the plural form split on `;` only
//  - phrases (an HMAC id:secret:Display Name, a TOTP secret:name[:digits]): the
//    singular form never splits; the environment variable and the plural form
//    split on `;` if the value has one, else on `,`, and on newlines, never on
//    spaces
//  - anything else (tokens, paths, rules): as phrases for the singular form,
//    as identifiers for the environment variable and the plural form
export type ArrayKind = 'identifiers' | 'dns' | 'phrases';

export type ConfigEntry = [
  string, // arg
  string, // env value
  (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    string | string[] | boolean | number | Record<string, any>
  ), // default value
  ('string' | 'number' | 'boolean' | 'array' | 'json' | null | undefined)?, // type
  (string | null | undefined)?, // for array type, the plural form of cliArg (e.g. --plugin / --plugins)
  ArrayKind?, // for array type, what the values hold: see ArrayKind
  boolean?, // whether an empty environment value is refused instead of read as unset: for a default that is a guess, not a safe fallback
  (string[] | null | undefined)?, // CLI names kept as deprecated aliases, with their leading --
  (string[] | null | undefined)?, // environment variables kept as deprecated aliases
];

export class ConfigParser {
  private config: ConfigTemplate;
  /** CLI arguments no entry declared, kept in `Config` by the parser */
  private unknownArgs: string[] = [];
  /** Deprecated names the configuration used, reported once each */
  private readonly deprecated: string[] = [];

  get unknownOptions(): string[] {
    return [...this.unknownArgs];
  }

  /** Names read through a deprecated alias, for the server to warn about */
  get deprecationWarnings(): string[] {
    return [...this.deprecated];
  }

  private warnOnce(message: string): void {
    if (!this.deprecated.includes(message)) this.deprecated.push(message);
  }

  /** The entry a CLI name stands for, whether canonical or a deprecated alias */
  private findEntry(arg: string): ConfigEntry | undefined {
    const canonical = this.config.find(entry => entry[0] === arg);
    if (canonical) return canonical;
    const aliased = this.config.find(entry => entry[7]?.includes(arg));
    if (aliased)
      this.warnOnce(`Configuration: ${arg} is deprecated, use ${aliased[0]}`);
    return aliased;
  }

  /**
   * The environment variable an entry reads: its own, or a deprecated alias
   * when that one is set and its own is not.
   */
  private envNameOf(
    entry: ConfigEntry,
    cliArgs: Map<string, ConfigResultValue>
  ): string | undefined {
    const primary = entry[1] || undefined;
    if (!primary) return undefined;
    if (this.environmentIsSet(entry, process.env[primary])) return primary;
    // A singular CLI value replaces the environment one; an array one
    // combines with it, so its deprecated variable is still read
    if (entry[3] !== 'array' && cliArgs.has(entry[0])) return primary;
    for (const alias of entry[8] ?? []) {
      if (alias && this.environmentIsSet(entry, process.env[alias])) {
        this.warnOnce(`Configuration: ${alias} is deprecated, use ${primary}`);
        return alias;
      }
    }
    return primary;
  }

  /**
   * Whether a variable value counts as set. An empty value is unset for the
   * types that read it as nothing: a compose file expands an unset
   * `${VAR:-}` to one. For a string or a boolean, an empty value means
   * something and stays set.
   */
  private environmentIsSet(
    entry: ConfigEntry,
    value: string | undefined
  ): boolean {
    if (value === undefined) return false;
    if (entry[3] === 'array')
      return splitValue(value, entry[5], 'plural').length > 0;
    if (entry[3] === 'number' || entry[3] === 'json')
      return value.trim() !== '';
    return true;
  }

  constructor(config: ConfigTemplate) {
    this.config = config;
    this.checkAliases();
  }

  /** A deprecated name must not shadow a declared one, or be declared twice */
  private checkAliases(): void {
    const declared = new Set<string>();
    for (const entry of this.config)
      for (const name of [entry[0], entry[4], entry[1]])
        if (name) declared.add(name);
    const aliases = new Set<string>();
    for (const entry of this.config)
      for (const alias of [...(entry[7] ?? []), ...(entry[8] ?? [])]) {
        if (declared.has(alias))
          throw new Error(
            `Configuration: alias ${alias} of ${entry[0]} is already a declared name`
          );
        if (aliases.has(alias))
          throw new Error(
            `Configuration: alias ${alias} of ${entry[0]} is declared twice`
          );
        aliases.add(alias);
      }
  }

  parse(argv: string[] = process.argv): Config {
    this.deprecated.length = 0;
    // @ts-expect-error: missing port
    const result: Config = {};
    const cliArgs = this.parseCliArgs(argv);
    for (const entry of this.config) {
      const key = this.getKeyFromCliArg(entry[0]);
      let value: ConfigResultValue = entry[2];
      let fromDefault = true;

      // Override with env value if exists
      const envName = this.envNameOf(entry, cliArgs);
      if (envName !== undefined) {
        const envValue = process.env[envName];
        // An empty value, or an array one without any item, is unset: a
        // compose file expands an unset `${VAR:-}` to one, and it would
        // replace the default with nothing (or NaN for a number)
        const items =
          entry[3] === 'array' && envValue !== undefined
            ? splitValue(envValue, entry[5], 'plural')
            : [];
        const empty =
          envValue !== undefined &&
          ((entry[3] === 'array' && items.length === 0) ||
            ((entry[3] === 'number' || entry[3] === 'json') &&
              envValue.trim() === ''));
        if (empty && entry[6])
          throw new Error(
            `Error in environment variable ${envName}: the value is empty. ` +
              'Set it, or leave the variable out'
          );
        if (envValue !== undefined && !empty) {
          fromDefault = false;
          if (entry[3] === 'boolean') {
            value = envValue.toLowerCase() === 'true';
          } else if (entry[3] === 'number') {
            value = parseNumber(envValue);
            if (Number.isNaN(value))
              throw new Error(
                `Error in environment variable ${envName}: "${envValue}" is not a number`
              );
          } else if (entry[3] === 'array') {
            value = items;
          } else if (entry[3] === 'json') {
            try {
              value = JSON.parse(envValue) as Record<string, AttributeValue>;
            } catch (e) {
              throw new Error(
                // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                `Error parsing JSON from environment variable ${envName}: ${e}`
              );
            }
          } else {
            value = envValue;
          }
        }
      }

      // Override with CLI arg if exists
      if (cliArgs.has(entry[0])) {
        const cliValue = cliArgs.get(entry[0]);
        if (entry[3] === 'boolean') {
          value = true;
        } else if (entry[3] === 'number') {
          value = cliValue;
        } else if (entry[3] === 'array') {
          value = (fromDefault ? [] : (value as string[])).concat(
            (cliValue as string[]).flatMap(v =>
              splitCliValue(entry[0], v, entry[5], 'singular')
            )
          );
          fromDefault = false;
        } else if (entry[3] === 'json') {
          try {
            value = JSON.parse(cliValue as string) as Record<
              string,
              AttributeValue
            >;
          } catch (e) {
            throw new Error(
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              `Error parsing JSON from command line argument ${entry[0]}: ${e}`
            );
          }
        } else {
          value = cliValue;
        }
        cliArgs.delete(entry[0]);
      }
      if (entry[3] === 'array' && entry[4] && cliArgs.has(entry[4])) {
        const cliValue = cliArgs.get(entry[4]) as string | undefined;
        value = (fromDefault ? [] : (value as string[])).concat(
          splitCliValue(entry[4], cliValue, entry[5], 'plural')
        );
        cliArgs.delete(entry[4]);
      }

      result[key as keyof Config] = value as never;
    }

    // Store additional arguments
    this.unknownArgs = [];
    cliArgs.forEach((v, k) => {
      if ((result as unknown as Record<string, unknown>)[k]) {
        throw new Error(`Error in command line: ${k} redefined`);
      }
      this.unknownArgs.push(k);
      (result as unknown as Record<string, unknown>)[
        k.replace(/^-+/, '').replace(/-/g, '_')
      ] = v;
    });

    return result;
  }

  // Command-line parser
  private parseCliArgs(argv: string[]): Map<string, ConfigResultValue> {
    const args = new Map<string, ConfigResultValue>();

    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];

      if (arg.startsWith('--') || arg.startsWith('-')) {
        const configEntry = this.findEntry(arg);
        // A deprecated alias is read as the name it stands for, so the
        // configuration and the unknown-option report see one name only
        const name = configEntry ? configEntry[0] : arg;

        if (configEntry && configEntry[3] === 'boolean') {
          args.set(name, true);
        } else if (configEntry && configEntry[3] === 'number') {
          if (!argv[i + 1]?.trim())
            throw new Error(
              `Error in command line: ${arg} has an empty value. Leave it ` +
                'out to keep the default'
            );
          const number = parseNumber(argv[i + 1]);
          if (Number.isNaN(number))
            throw new Error(
              `Error in command line: ${arg} takes a number, got ` +
                `"${argv[i + 1]}"`
            );
          args.set(name, number);
          i++; // The value may start with `-`, as -1 does
        } else if (configEntry && configEntry[3] === 'array') {
          const tmp = args.get(name) || [];
          const nextArg = argv[i + 1];
          (tmp as string[]).push(nextArg);
          args.set(name, tmp);
          // One value per occurrence, and a second word after it used to be
          // skipped in silence: `--authz-for oidc authToken` read as
          // `["oidc"]`, a population smaller than the command line says —
          // and for an authorization scope, requests of `authToken` nobody
          // judges. The plural form takes several values, so does not refuse;
          // the singular takes one, so it refuses.
          const stray = argv[i + 2];
          if (stray !== undefined && !stray.startsWith('-'))
            throw new Error(
              `Error in command line: ${arg} takes one value, got ` +
                `"${nextArg}" followed by "${stray}". Repeat ${arg} for each ` +
                'value' +
                (configEntry[4]
                  ? `, or give them all to ${configEntry[4]}`
                  : '')
            );
        } else {
          const nextArg = argv[i + 1];
          args.set(name, nextArg);
          i++; // Skip la valeur qu'on vient de traiter
        }
      }
    }

    return args;
  }

  private getKeyFromCliArg(cliArg: string): string {
    if (cliArg.startsWith('--')) {
      return cliArg.substring(2).replace(/-/g, '_');
    } else if (cliArg.startsWith('-')) {
      return cliArg.substring(1).replace(/-/g, '_');
    }
    return cliArg;
  }
}

// The separator depends on what the option holds and on where the value
// comes from, see ArrayKind. Items are trimmed and empty ones dropped
export function splitValue(
  value: string,
  kind: ArrayKind | undefined,
  form: 'singular' | 'plural'
): string[] {
  let separator: RegExp | undefined;
  if (form === 'singular') {
    if (kind === 'identifiers') separator = /,/;
  } else if (kind === 'dns') separator = /;/;
  else {
    const spaces = kind === 'phrases' ? '\\r\\n' : '\\s';
    separator = new RegExp(`[${value.includes(';') ? ';' : ','}${spaces}]+`);
  }
  return separator
    ? value
        .split(separator)
        .map(v => v.trim())
        .filter(v => v.length > 0)
    : [value.trim()].filter(v => v.length > 0);
}

// An integer only: parseInt would read 1e3 as 1 and 80abc as 80
export function parseNumber(value: string): number {
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

// An unset variable expands to an empty value, which would replace the
// default with nothing
function splitCliValue(
  arg: string,
  value: string | undefined,
  kind: ArrayKind | undefined,
  form: 'singular' | 'plural'
): string[] {
  const values = value === undefined ? [] : splitValue(value, kind, form);
  if (values.length === 0)
    throw new Error(
      `Error in command line: ${arg} has an empty value. Leave it out to ` +
        'keep the default'
    );
  return values;
}

export function parseConfig(
  config: ConfigEntry[],
  argv: string[] = process.argv
): Config {
  const parser = new ConfigParser(config);
  return parser.parse(argv);
}
