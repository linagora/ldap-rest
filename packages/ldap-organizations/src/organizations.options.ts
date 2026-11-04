/** Organizations plugin options. */
import type { Config } from '@ldap-rest/core/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '@ldap-rest/core/config/options';

export const organizationOptions = defineOptions({
  ldap_top_organization: opt.string({
    env: 'DM_LDAP_TOP_ORGANIZATION',
    default: '',
  }),
  ldap_organization_class: opt.array({
    env: 'DM_LDAP_ORGANIZATION_CLASSES',
    default: ['top', 'organizationalUnit', 'twakeDepartment'],
    plural: 'ldap-organization-classes',
    kind: 'identifiers',
  }),
  ldap_organization_link_attribute: opt.string({
    env: 'DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE',
    default: 'twakeDepartmentLink',
  }),
  ldap_organization_path_attribute: opt.string({
    env: 'DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE',
    default: 'twakeDepartmentPath',
  }),
  ldap_organization_path_separator: opt.string({
    env: 'DM_LDAP_ORGANIZATION_PATH_SEPARATOR',
    default: ' / ',
  }),
  ldap_organization_max_subnodes: opt.number({
    env: 'DM_LDAP_ORGANIZATION_MAX_SUBNODES',
    default: 50,
    min: 1,
  }),
  organization_schema: opt.string({
    env: 'DM_ORGANIZATION_SCHEMA',
    default: '',
  }),
});
export type OrganizationOptions = OptionsOf<typeof organizationOptions>;

/** The checked values for a caller that holds a Config instead of the plugin */
export function organizationOptionsOf(config: Config): OrganizationOptions {
  return readOptions(organizationOptions, config);
}
