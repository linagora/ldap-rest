/**
 * Twake Mail migration proxy options, see `docs/plugin-development/options.md`.
 */
import type { Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const migrationProxyOptions = defineOptions({
  migration_proxy_url: opt.string({
    env: 'DM_MIGRATION_PROXY_URL',
    default: '',
  }),
  migration_proxy_token: opt.string({
    env: 'DM_MIGRATION_PROXY_TOKEN',
    default: '',
  }),
  migration_proxy_branch: opt.array({
    env: 'DM_MIGRATION_PROXY_BRANCHES',
    default: [],
    plural: 'migration-proxy-branches',
    kind: 'dns',
  }),
  migration_proxy_concurrency: opt.number({
    env: 'DM_MIGRATION_PROXY_CONCURRENCY',
    default: 10,
    min: 1,
  }),
  migration_proxy_retry_attempts: opt.number({
    env: 'DM_MIGRATION_PROXY_RETRY_ATTEMPTS',
    default: 5,
  }),
  migration_proxy_retry_delay: opt.number({
    env: 'DM_MIGRATION_PROXY_RETRY_DELAY',
    default: 1000,
  }),
});

export type MigrationProxyOptions = OptionsOf<typeof migrationProxyOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function migrationProxyOptionsOf(config: Config): MigrationProxyOptions {
  return readOptions(migrationProxyOptions, config);
}
