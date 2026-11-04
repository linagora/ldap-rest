/** Generic flat entities plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const flatGenericOptions = defineOptions({
  ldap_flat_schema: opt.array({
    env: 'DM_LDAP_FLAT_SCHEMA',
    default: [],
    plural: 'ldap-flat-schemas',
  }),
  ldap_flat_auto_repair: opt.boolean({
    env: 'DM_LDAP_FLAT_AUTO_REPAIR',
    default: true,
  }),
});
export type FlatGenericOptions = OptionsOf<typeof flatGenericOptions>;
