/** Metrics plugin options, see `docs/plugin-development/options.md`. */
import type { Config } from '../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../config/options';

export const metricsOptions = defineOptions({
  metrics_port: opt.number({ env: 'DM_METRICS_PORT', default: 9464 }),
});
export type MetricsOptions = OptionsOf<typeof metricsOptions>;

export function metricsOptionsOf(config: Config): MetricsOptions {
  return readOptions(metricsOptions, config);
}
