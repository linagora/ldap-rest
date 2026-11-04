/** Rate limit guard options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const rateLimitOptions = defineOptions({
  rate_limit_window_ms: opt.number({
    env: 'DM_RATE_LIMIT_WINDOW_MS',
    default: 15 * 60 * 1000,
    min: 1,
  }),
  rate_limit_max: opt.number({
    env: 'DM_RATE_LIMIT_MAX',
    default: 100,
    min: 1,
  }),
});
export type RateLimitOptions = OptionsOf<typeof rateLimitOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function rateLimitOptionsOf(config: Config): RateLimitOptions {
  return readOptions(rateLimitOptions, config);
}
