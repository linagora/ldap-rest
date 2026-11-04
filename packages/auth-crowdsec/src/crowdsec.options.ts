/** CrowdSec guard options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const crowdsecOptions = defineOptions({
  crowdsec_url: opt.string({
    env: 'DM_CROWDSEC_URL',
    default: 'http://localhost:8080/v1/decisions',
  }),
  crowdsec_api_key: opt.string({
    env: 'DM_CROWDSEC_API_KEY',
    default: '',
  }),
  crowdsec_cache_ttl: opt.number({
    env: 'DM_CROWDSEC_CACHE_TTL',
    default: 60,
    min: 1,
  }),
});
export type CrowdsecOptions = OptionsOf<typeof crowdsecOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function crowdsecOptionsOf(config: Config): CrowdsecOptions {
  return readOptions(crowdsecOptions, config);
}
