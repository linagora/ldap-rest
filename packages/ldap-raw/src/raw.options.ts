/** Raw LDAP plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const rawOptions = defineOptions({
  ldap_raw_base: opt.array({
    env: 'DM_LDAP_RAW_BASE',
    default: [],
    plural: 'ldap-raw-bases',
    kind: 'dns',
  }),
  ldap_raw_hidden_attribute: opt.array({
    env: 'DM_LDAP_RAW_HIDDEN_ATTRIBUTES',
    default: [],
    plural: 'ldap-raw-hidden-attributes',
    kind: 'identifiers',
  }),
  ldap_raw_show_secrets: opt.boolean({
    env: 'DM_LDAP_RAW_SHOW_SECRETS',
    default: false,
  }),
  ldap_raw_max_results: opt.number({
    env: 'DM_LDAP_RAW_MAX_RESULTS',
    default: 200,
    min: 1,
  }),
  ldap_raw_schema_cache_ttl: opt.number({
    env: 'DM_LDAP_RAW_SCHEMA_CACHE_TTL',
    default: 3600,
  }),
});
export type RawOptions = OptionsOf<typeof rawOptions>;
