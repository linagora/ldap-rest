/** TOTP authentication plugin options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const totpOptions = defineOptions({
  auth_totp: opt.array({
    env: 'DM_AUTH_TOTP',
    default: [],
    plural: 'auth-totps',
    kind: 'phrases',
  }),
  auth_totp_window: opt.number({
    env: 'DM_AUTH_TOTP_WINDOW',
    default: 1,
  }),
  auth_totp_step: opt.number({
    env: 'DM_AUTH_TOTP_STEP',
    default: 30,
    min: 1,
  }),
});
export type TotpOptions = OptionsOf<typeof totpOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function totpOptionsOf(config: Config): TotpOptions {
  return readOptions(totpOptions, config);
}
