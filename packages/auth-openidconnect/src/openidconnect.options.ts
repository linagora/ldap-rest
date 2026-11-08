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
  // Separate from the client secret on purpose: the library derives the
  // session cookie's encryption key from it, so anyone holding the client
  // secret could otherwise forge an administrator's session.
  oidc_session_secret: opt.array({
    env: 'DM_OIDC_SESSION_SECRET',
    default: [],
    plural: 'oidc-session-secrets',
    kind: 'phrases',
  }),
  base_url: opt.string({ env: 'DM_BASE_URL', default: '' }),
  oidc_logout_origins: opt.array({
    env: 'DM_OIDC_LOGOUT_ORIGINS',
    default: [],
    plural: 'oidc-logout-origins',
  }),
});
export type OpenidconnectOptions = OptionsOf<typeof openidconnectOptions>;
