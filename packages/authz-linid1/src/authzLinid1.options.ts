/** LinId1 authorization plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const linid1Options = defineOptions({
  authz_local_admin_attribute: opt.string({
    env: 'DM_AUTHZ_LOCAL_ADMIN_ATTRIBUTE',
    default: 'twakeLocalAdminLink',
  }),
  authz_linid1_cache_ttl: opt.number({
    env: 'DM_AUTHZ_LINID1_CACHE_TTL',
    default: 300,
    min: 1,
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
  authz_group_admin_attribute: opt.string({
    env: 'DM_AUTHZ_GROUP_ADMIN_ATTRIBUTE',
    default: '',
    emptyIsValue: true,
  }),
});
export type Linid1Options = OptionsOf<typeof linid1Options>;
