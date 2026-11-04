/**
 * The LDAP plugin options, at their historical path.
 *
 * Each plugin declares its own, next to its class; this module keeps the
 * former `./plugin-ldap-ldap.options` sub-path exporting all of them. See
 * `docs/development/modularization-plan.md`.
 */
export {
  bulkImportOptions,
  type BulkImportOptions,
} from '@ldap-rest/ldap-bulkimport/options';
export {
  enterpriseRulesOptions,
  type EnterpriseRulesOptions,
} from '@ldap-rest/ldap-enterpriserules/options';
export {
  externalUsersOptions,
  type ExternalUsersOptions,
} from '@ldap-rest/ldap-externalusers/options';
export {
  flatGenericOptions,
  type FlatGenericOptions,
} from '@ldap-rest/ldap-flatgeneric/options';
export {
  groupsOptions,
  groupsOptionsOf,
  type GroupsOptions,
} from '@ldap-rest/ldap-groups/options';
export {
  organizationOptions,
  organizationOptionsOf,
  type OrganizationOptions,
} from '@ldap-rest/ldap-organizations/options';
export {
  passwordPolicyOptions,
  type PasswordPolicyOptions,
} from '@ldap-rest/ldap-passwordpolicy/options';
export { rawOptions, type RawOptions } from '@ldap-rest/ldap-raw/options';
export {
  trashOptions,
  trashOptionsOf,
  type TrashOptions,
} from '@ldap-rest/ldap-trash/options';
