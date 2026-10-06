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
];

export class ConfigParser {
  private config: ConfigTemplate;

  constructor(config: ConfigTemplate) {
    this.config = config;
  }

  parse(argv: string[] = process.argv): Config {
    // @ts-expect-error: missing port
    const result: Config = {};
    const cliArgs = this.parseCliArgs(argv);
    for (const entry of this.config) {
      const key = this.getKeyFromCliArg(entry[0]);
      let value: ConfigResultValue = entry[2];
      let fromDefault = true;

      // Override with env value if exists
      if (entry[1] !== undefined) {
        const envValue = process.env[entry[1]];
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
            `Error in environment variable ${entry[1]}: the value is empty. ` +
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
                `Error in environment variable ${entry[1]}: "${envValue}" is not a number`
              );
          } else if (entry[3] === 'array') {
            value = items;
          } else if (entry[3] === 'json') {
            try {
              value = JSON.parse(envValue) as Record<string, AttributeValue>;
            } catch (e) {
              throw new Error(
                // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                `Error parsing JSON from environment variable ${entry[1]}: ${e}`
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
          value = cliValue as number;
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
          value = cliValue as string;
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
    cliArgs.forEach((v, k) => {
      if (result[k]) {
        throw new Error(`Error in command line: ${k} redefined`);
      }
      result[k.replace(/^-+/, '').replace(/-/g, '_')] = v;
    });

    return result;
  }

  // Command-line parser
  private parseCliArgs(argv: string[]): Map<string, ConfigResultValue> {
    const args = new Map<string, ConfigResultValue>();

    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];

      if (arg.startsWith('--') || arg.startsWith('-')) {
        const configEntry = this.config.find(entry => entry[0] === arg);

        if (configEntry && configEntry[3] === 'boolean') {
          args.set(arg, true);
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
          args.set(arg, number);
          i++; // The value may start with `-`, as -1 does
        } else if (configEntry && configEntry[3] === 'array') {
          const tmp = args.get(arg) || [];
          const nextArg = argv[i + 1];
          (tmp as string[]).push(nextArg);
          args.set(arg, tmp);
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
          args.set(arg, nextArg);
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
function splitValue(
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
function parseNumber(value: string): number {
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
