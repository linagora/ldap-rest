/** RabbitMQ plugin options, see `docs/plugin-development/options.md`. */
import type { Config } from '../config/args.js';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../config/options.js';

export const rabbitmqOptions = defineOptions({
  rabbitmq_url: opt.string({ env: 'DM_RABBITMQ_URL', default: '' }),
});
export type RabbitmqOptions = OptionsOf<typeof rabbitmqOptions>;

export function rabbitmqOptionsOf(config: Config): RabbitmqOptions {
  return readOptions(rabbitmqOptions, config);
}
