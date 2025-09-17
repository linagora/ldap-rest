import { type Config } from '../config/args';

export type ConfigTemplate = ConfigEntry[];

export interface ConfigEntry {
  cliArg: string;
  envVar: string;
  defaultValue: string | number | boolean;
  isBoolean?: boolean;
  isInteger?: boolean;
}

type ConfigResultValue = string | boolean | number | undefined;

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
      let value: string | boolean | number = entry.defaultValue;

      // Override with env value if exists
      const envValue = process.env[entry.envVar];
      if (envValue !== undefined) {
        if (entry.isBoolean) {
          value = envValue.toLowerCase() === 'true';
        } else if (entry.isInteger) {
          value = parseInt(envValue);
        } else {
          value = envValue;
        }
      }

      // Override with CLI arg if exists
      if (cliArgs.has(entry.cliArg)) {
        const cliValue = cliArgs.get(entry.cliArg);
        if (entry.isBoolean) {
          value = cliValue === true || cliValue === 'true';
        } else if (entry.isInteger) {
          value = parseInt(cliValue as string);
        } else {
          value = cliValue as string;
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

        if (configEntry?.isBoolean) {
          args.set(arg, true);
        } else if (configEntry?.isInteger) {
          args.set(arg, parseInt(argv[i + 1]));
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
