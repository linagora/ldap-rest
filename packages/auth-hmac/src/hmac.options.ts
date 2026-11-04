/** HMAC authentication plugin options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const hmacOptions = defineOptions({
  auth_hmac: opt.array({
    env: 'DM_AUTH_HMAC',
    default: [],
    plural: 'auth-hmacs',
    kind: 'phrases',
  }),
  auth_hmac_window: opt.number({
    env: 'DM_AUTH_HMAC_WINDOW',
    default: 120000,
    min: 1,
  }),
});
export type HmacOptions = OptionsOf<typeof hmacOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function hmacOptionsOf(config: Config): HmacOptions {
  return readOptions(hmacOptions, config);
}
