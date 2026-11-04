/** Per-branch authorization plugin options. */
import type { AuthConfig, Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

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
  ldap_group_member_attribute: opt.string({
    env: 'DM_LDAP_GROUP_MEMBER_ATTRIBUTE',
    default: 'member',
  }),
});
export type PerBranchOptions = OptionsOf<typeof perBranchOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function perBranchOptionsOf(config: Config): PerBranchOptions {
  return readOptions(perBranchOptions, config);
}
