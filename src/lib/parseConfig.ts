import { type Config } from '../config/args';

export type ConfigTemplate = ConfigEntry[];

type ConfigResultValue = string | string[] | boolean | number | undefined;

export interface ConfigEntry {
  cliArg: string;
  envVar?: string;
  defaultValue?: string | string[] | boolean | number;
  type?: 'string' | 'number' | 'boolean' | 'array';
}

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
      const key = this.getKeyFromCliArg(entry.cliArg);
      let value: ConfigResultValue = entry.defaultValue;

      // Override with env value if exists
      if (entry.envVar !== undefined) {
        const envValue = process.env[entry.envVar];
        if (envValue !== undefined) {
          if (entry.type === 'boolean') {
            value = envValue.toLowerCase() === 'true';
          } else if (entry.type === 'number') {
            value = parseInt(envValue);
          } else if (entry.type === 'array') {
            value = envValue.split(/[,\s]+/).filter(v => v.length > 0);
          } else {
            value = envValue;
          }
        }
      }

      // Override with CLI arg if exists
      if (cliArgs.has(entry.cliArg)) {
        const cliValue = cliArgs.get(entry.cliArg);
        if (entry.type === 'boolean') {
          value = true;
        } else if (entry.type === 'number') {
          value = parseInt(cliValue as string);
        } else if (entry.type === 'array') {
          if (Array.isArray(value)) {
            value = value.concat(cliValue as string[]);
          } else {
            value = cliValue as string[];
          }
        } else {
          value = cliValue as string;
        }
      }
      if (entry.type === 'array' && cliArgs.has(entry.cliArg + 's')) {
        const cliValue = cliArgs.get(entry.cliArg + 's') || '';
        if (Array.isArray(value)) {
          value = value.concat(
            (cliValue as string).split(/[,\s]+/).filter(v => v.length > 0)
          );
        } else {
          value = (cliValue as string)
            .split(/[,\s]+/)
            .filter(v => v.length > 0);
        }
      }

      result[key as keyof Config] = value as never;
    }

    return result;
  }

  // Command-line parser
  private parseCliArgs(argv: string[]): Map<string, ConfigResultValue> {
    const args = new Map<string, ConfigResultValue>();

    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];

      if (arg.startsWith('--') || arg.startsWith('-')) {
        const configEntry = this.config.find(entry => entry.cliArg === arg);

        if (configEntry?.type === 'boolean') {
          args.set(arg, true);
        } else if (configEntry?.type === 'number') {
          args.set(arg, parseInt(argv[i + 1]));
        } else if (configEntry?.type === 'array') {
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
