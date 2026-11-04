/** Enterprise rules plugin options. */
import {
  defineOptions,
  opt,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const enterpriseRulesOptions = defineOptions({
  enterprise_domain_name_attribute: opt.string({
    env: 'DM_ENTERPRISE_DOMAIN_NAME_ATTRIBUTE',
    default: 'associatedDomain',
  }),
  enterprise_domain_link_attribute: opt.string({
    env: 'DM_ENTERPRISE_DOMAIN_LINK_ATTRIBUTE',
    default: '',
  }),
});
export type EnterpriseRulesOptions = OptionsOf<typeof enterpriseRulesOptions>;
