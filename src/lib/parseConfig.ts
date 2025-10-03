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

export type ConfigEntry = [
  string, // arg
  string, // env value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  string | string[] | boolean | number | Record<string, any>, // default value
  ('string' | 'number' | 'boolean' | 'array' | 'json' | null | undefined)?, // type
  (string | null | undefined)?, // for array type, the plural form of cliArg (e.g. --plugin / --plugins)
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

      // Override with env value if exists
      if (entry[1] !== undefined) {
        const envValue = process.env[entry[1]];
        if (envValue !== undefined) {
          if (entry[3] === 'boolean') {
            value = envValue.toLowerCase() === 'true';
          } else if (entry[3] === 'number') {
            value = parseInt(envValue);
          } else if (entry[3] === 'array') {
            const sep = envValue.indexOf(';') > 0 ? ';' : ',';
            value = envValue
              .split(new RegExp(`[${sep}\\s]+`))
              .map(v => v.trim())
              .filter(v => v.length > 0);
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
          value = parseInt(cliValue as string);
        } else if (entry[3] === 'array') {
          if (Array.isArray(value)) {
            value = value.concat(cliValue as string[]);
          } else {
            value = cliValue as string[];
          }
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
        const cliValue = cliArgs.get(entry[4]) || '';
        if (Array.isArray(value)) {
          value = value.concat(
            (cliValue as string).split(/[,\s]+/).filter(v => v.length > 0)
          );
        } else {
          value = (cliValue as string)
            .split(/[,\s]+/)
            .filter(v => v.length > 0);
        }
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
          args.set(arg, parseInt(argv[i + 1]));
        } else if (configEntry && configEntry[3] === 'array') {
          const tmp = args.get(arg) || [];
          const nextArg = argv[i + 1];
          (tmp as string[]).push(nextArg);
          args.set(arg, tmp);
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

export function parseConfig(
  config: ConfigEntry[],
  argv: string[] = process.argv
): Config {
  const parser = new ConfigParser(config);
  return parser.parse(argv);
}
