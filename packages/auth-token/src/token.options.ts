/** Token authentication plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const tokenOptions = defineOptions({
  auth_token: opt.array({
    env: 'DM_AUTH_TOKENS',
    default: [],
    plural: 'auth-tokens',
  }),
});
export type TokenOptions = OptionsOf<typeof tokenOptions>;
