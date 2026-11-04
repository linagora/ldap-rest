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
