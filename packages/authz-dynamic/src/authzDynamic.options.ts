/** Dynamic authorization plugin options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const dynamicOptions = defineOptions({
  // Who may reach the directory through this plugin without presenting one
  // of its tokens. Empty — the default — means nobody: a request is checked
  // against the ACLs of the token it carries, whatever else authenticated
  // it. Values are identities as another authenticator publishes them in
  // `req.user`, plus two words:
  //
  //  - `any-authenticated`: anything another plugin authenticated, which is
  //    what the plugin did until 0.9.0, by accident rather than by decision;
  //  - `trusted-proxy`: a request `core/auth/trustedProxy` vouched for.
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

/** The checked values for a caller that holds a Config instead of the plugin */
export function dynamicOptionsOf(config: Config): DynamicOptions {
  return readOptions(dynamicOptions, config);
}
