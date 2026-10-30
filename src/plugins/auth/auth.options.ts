/**
 * Authentication and authorization plugin options, see
 * `docs/plugin-development/options.md`.
 */
import type { AuthConfig, Config } from '../../config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

export const tokenOptions = defineOptions({
  auth_token: opt.array({
    env: 'DM_AUTH_TOKENS',
    default: [],
    plural: 'auth-tokens',
  }),
});
export type TokenOptions = OptionsOf<typeof tokenOptions>;

export const fakeOptions = defineOptions({
  auth_fake_user: opt.string({ env: 'DM_AUTH_FAKE_USER', default: '' }),
});
export type FakeOptions = OptionsOf<typeof fakeOptions>;

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

export const llngOptions = defineOptions({
  llng_ini: opt.string({
    env: 'DM_LLNG_INI',
    default: '/etc/lemonldap-ng/lemonldap-ng.ini',
  }),
  llng_username_header: opt.string({
    env: 'DM_LLNG_USERNAME_HEADER',
    default: '',
  }),
});
export type LlngOptions = OptionsOf<typeof llngOptions>;

export const perRouteOptions = defineOptions({
  authz_per_route: opt.array({
    env: 'DM_AUTHZ_PER_ROUTES',
    default: [],
    plural: 'authz-per-routes',
  }),
});
export type PerRouteOptions = OptionsOf<typeof perRouteOptions>;

export const perBranchOptions = defineOptions({
  authz_per_branch_config: opt.json<AuthConfig>({
    env: 'DM_AUTHZ_PER_BRANCH_CONFIG',
    default: { default: { read: true, write: false, delete: false } },
  }),
  authz_per_branch_cache_ttl: opt.number({
    env: 'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    default: 60,
    min: 1,
  }),
});
export type PerBranchOptions = OptionsOf<typeof perBranchOptions>;

export const dynamicOptions = defineOptions({
  authz_dynamic_bypass: opt.array({
    env: 'DM_AUTHZ_DYNAMIC_BYPASS',
    default: [],
    kind: 'identifiers',
  }),
  authz_dynamic_base: opt.string({
    env: 'DM_AUTHZ_DYNAMIC_BASE',
    default: '',
  }),
  authz_dynamic_cache_ttl: opt.number({
    env: 'DM_AUTHZ_DYNAMIC_CACHE_TTL',
    default: 60,
    min: 1,
  }),
  authz_dynamic_token_attribute: opt.string({
    env: 'DM_AUTHZ_DYNAMIC_TOKEN_ATTRIBUTE',
    default: 'userPassword',
  }),
  authz_dynamic_config_attribute: opt.string({
    env: 'DM_AUTHZ_DYNAMIC_CONFIG_ATTRIBUTE',
    default: 'description',
  }),
  authz_dynamic_tenant_attribute: opt.string({
    env: 'DM_AUTHZ_DYNAMIC_TENANT_ATTRIBUTE',
    default: 'cn',
  }),
  authz_dynamic_reload_endpoint: opt.boolean({
    env: 'DM_AUTHZ_DYNAMIC_RELOAD_ENDPOINT',
    default: false,
  }),
});
export type DynamicOptions = OptionsOf<typeof dynamicOptions>;

export const linid1Options = defineOptions({
  authz_local_admin_attribute: opt.string({
    env: 'DM_AUTHZ_LOCAL_ADMIN_ATTRIBUTE',
    default: 'twakeLocalAdminLink',
  }),
  authz_global_branch: opt.array({
    env: 'DM_AUTHZ_GLOBAL_BRANCHES',
    default: [],
    plural: 'authz-global-branches',
    kind: 'dns',
  }),
  authz_global_write_branch: opt.array({
    env: 'DM_AUTHZ_GLOBAL_WRITE_BRANCHES',
    default: [],
    plural: 'authz-global-write-branches',
    kind: 'dns',
  }),
  authz_global_organization: opt.string({
    env: 'DM_AUTHZ_GLOBAL_ORGANIZATION',
    default: '',
  }),
});
export type Linid1Options = OptionsOf<typeof linid1Options>;

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
});
export type OpenidconnectOptions = OptionsOf<typeof openidconnectOptions>;

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

/** The checked values for a caller that holds a Config instead of the plugin */
export function totpOptionsOf(config: Config): TotpOptions {
  return readOptions(totpOptions, config);
}
export function hmacOptionsOf(config: Config): HmacOptions {
  return readOptions(hmacOptions, config);
}
export function perBranchOptionsOf(config: Config): PerBranchOptions {
  return readOptions(perBranchOptions, config);
}
export function dynamicOptionsOf(config: Config): DynamicOptions {
  return readOptions(dynamicOptions, config);
}
export function rateLimitOptionsOf(config: Config): RateLimitOptions {
  return readOptions(rateLimitOptions, config);
}
export function crowdsecOptionsOf(config: Config): CrowdsecOptions {
  return readOptions(crowdsecOptions, config);
}
