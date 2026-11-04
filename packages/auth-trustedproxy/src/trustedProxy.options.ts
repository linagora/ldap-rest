/** Trusted proxy authentication plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const trustedProxyOptions = defineOptions({
  trusted_proxy: opt.array({
    env: 'DM_TRUSTED_PROXIES',
    default: [],
    plural: 'trusted-proxies',
    kind: 'identifiers',
  }),
  trusted_proxy_auth_header: opt.string({
    env: 'DM_TRUSTED_PROXY_AUTH_HEADER',
    default: 'Auth-User',
  }),
});
export type TrustedProxyOptions = OptionsOf<typeof trustedProxyOptions>;
