/** OpenID Connect authentication plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const openidconnectOptions = defineOptions({
  oidc_server: opt.string({ env: 'DM_OIDC_SERVER', default: '' }),
  oidc_username_claim: opt.string({
    env: 'DM_OIDC_USERNAME_CLAIM',
    default: 'sub',
  }),
  oidc_client_id: opt.string({ env: 'DM_OIDC_CLIENT_ID', default: '' }),
  oidc_client_secret: opt.string({
    env: 'DM_OIDC_CLIENT_SECRET',
    default: '',
  }),
  base_url: opt.string({ env: 'DM_BASE_URL', default: '' }),
  oidc_logout_origins: opt.array({
    env: 'DM_OIDC_LOGOUT_ORIGINS',
    default: [],
    plural: 'oidc-logout-origins',
  }),
});
export type OpenidconnectOptions = OptionsOf<typeof openidconnectOptions>;
