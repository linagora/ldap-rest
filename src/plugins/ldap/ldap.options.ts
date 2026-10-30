/**
 * LDAP plugin options, see `docs/plugin-development/options.md`.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { Config } from '../../config/args';
import type { AttributesList } from '../../lib/ldapActions';
import {
  defineOptions,
  opt,
  readOptions,
  type OptionsOf,
} from '../../config/options';

const schemaPath = (...parts: string[]): string =>
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'static',
    'schemas',
    ...parts
  );

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

export const groupsOptions = defineOptions({
  ldap_group_base: opt.string({ env: 'DM_LDAP_GROUP_BASE', default: '' }),
  ldap_groups_main_attribute: opt.string({
    env: 'DM_LDAP_GROUPS_MAIN_ATTRIBUTE',
    default: 'cn',
  }),
  group_class: opt.array({
    env: 'DM_GROUP_CLASSES',
    default: ['top', 'groupOfNames'],
    plural: 'group-classes',
    kind: 'identifiers',
  }),
  groups_allow_unexistent_members: opt.boolean({
    env: 'DM_ALLOW_UNEXISTENT_MEMBERS',
    default: false,
  }),
  group_default_attributes: opt.json<AttributesList>({
    env: 'DM_GROUP_DEFAULT_ATTRIBUTES',
    default: {},
  }),
  group_dummy_user: opt.string({
    env: 'DM_GROUP_DUMMY_USER',
    default: 'cn=fakeuser',
    emptyIsValue: true,
  }),
  group_schema: opt.string({
    env: 'DM_GROUP_SCHEMA',
    default: schemaPath('twake', 'groups.json'),
    emptyIsValue: true,
  }),
});
export type GroupsOptions = OptionsOf<typeof groupsOptions>;

export const externalUsersOptions = defineOptions({
  external_members_branch: opt.string({
    env: 'DM_EXTERNAL_MEMBERS_BRANCH',
    default: 'ou=contacts,dc=example,dc=com',
  }),
  external_branch_class: opt.array({
    env: 'DM_EXTERNAL_BRANCH_CLASSES',
    default: ['top', 'inetOrgPerson'],
    plural: 'external-branch-classes',
    kind: 'identifiers',
  }),
});
export type ExternalUsersOptions = OptionsOf<typeof externalUsersOptions>;

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

export const bulkImportOptions = defineOptions({
  bulk_import_schemas: opt.string({
    env: 'DM_BULK_IMPORT_SCHEMAS',
    default: '',
  }),
  bulk_import_max_file_size: opt.string({
    env: 'DM_BULK_IMPORT_MAX_FILE_SIZE',
    default: '10485760',
  }),
  bulk_import_batch_size: opt.string({
    env: 'DM_BULK_IMPORT_BATCH_SIZE',
    default: '100',
  }),
});
export type BulkImportOptions = OptionsOf<typeof bulkImportOptions>;

export const trashOptions = defineOptions({
  trash_base: opt.string({ env: 'DM_TRASH_BASE', default: '' }),
  trash_watched_bases: opt.string({
    env: 'DM_TRASH_WATCHED_BASES',
    default: '',
  }),
  trash_add_metadata: opt.string({
    env: 'DM_TRASH_ADD_METADATA',
    default: 'true',
  }),
  trash_auto_create: opt.string({
    env: 'DM_TRASH_AUTO_CREATE',
    default: 'true',
  }),
});
export type TrashOptions = OptionsOf<typeof trashOptions>;

export const passwordPolicyOptions = defineOptions({
  ppolicy_default_dn: opt.string({
    env: 'DM_PPOLICY_DEFAULT_DN',
    default: '',
  }),
  ppolicy_base: opt.string({ env: 'DM_PPOLICY_BASE', default: '' }),
  ppolicy_warn_days: opt.number({
    env: 'DM_PPOLICY_WARN_DAYS',
    default: 14,
    min: 1,
  }),
  ppolicy_validate_complexity: opt.boolean({
    env: 'DM_PPOLICY_VALIDATE_COMPLEXITY',
    default: false,
  }),
  ppolicy_min_length: opt.number({
    env: 'DM_PPOLICY_MIN_LENGTH',
    default: 12,
    min: 1,
  }),
  ppolicy_require_uppercase: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_UPPERCASE',
    default: true,
  }),
  ppolicy_require_lowercase: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_LOWERCASE',
    default: true,
  }),
  ppolicy_require_digit: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_DIGIT',
    default: true,
  }),
  ppolicy_require_special: opt.boolean({
    env: 'DM_PPOLICY_REQUIRE_SPECIAL',
    default: true,
  }),
  ldap_users_base: opt.string({ env: 'DM_LDAP_USERS_BASE', default: '' }),
});
export type PasswordPolicyOptions = OptionsOf<typeof passwordPolicyOptions>;

export function organizationOptionsOf(config: Config): OrganizationOptions {
  return readOptions(organizationOptions, config);
}
export function groupsOptionsOf(config: Config): GroupsOptions {
  return readOptions(groupsOptions, config);
}
export function trashOptionsOf(config: Config): TrashOptions {
  return readOptions(trashOptions, config);
}
