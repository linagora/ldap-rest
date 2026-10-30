/**
 * command-line options, corresponding environment variables, default values and types
 * Contains also the typescript declaration of config
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { AttributesList } from '../lib/ldapActions';
import type { ConfigTemplate } from '../lib/parseConfig';
import { scimOptions } from '../plugins/scim/scim.options';
import { appAccountsOptions } from '../plugins/twake/appAccounts.options';
import { calendarOptions } from '../plugins/twake/calendar.options';
import { clouderyOptions } from '../plugins/twake/cloudery.options';
import { cozyOptions } from '../plugins/twake/cozy.options';
import { driveOptions } from '../plugins/twake/drive.options';
import { jamesOptions } from '../plugins/twake/james.options';
import { migrationProxyOptions } from '../plugins/twake/migrationProxy.options';
import { twakeGroupsOptions } from '../plugins/twake/twakeGroups.options';
import { twakeInstancesOptions } from '../plugins/twake/twakeInstances.options';
import { twakeLifecycleOptions } from '../plugins/twake/twakeLifecycle.options';
import { twakeSpacesOptions } from '../plugins/twake/twakeSpaces.options';
import { twakeTombstoneOptions } from '../plugins/twake/twakeTombstone.options';

import { toConfigEntries } from './options';

/** The headers `core/static` sends unless told otherwise: no framing by another site */
export const STATIC_CSP = "frame-ancestors 'self'";
export const STATIC_FRAME_OPTIONS = 'SAMEORIGIN';

export interface BranchPermissions {
  read?: boolean;
  write?: boolean;
  delete?: boolean;
}

export interface AuthConfig {
  default?: BranchPermissions;
  users?: {
    [uid: string]: {
      [branch: string]: BranchPermissions;
    };
  };
  groups?: {
    [groupDn: string]: {
      [branch: string]: BranchPermissions;
    };
  };
}

/**
 * Typescript declaration of config
 *
 * See below for config arguments, corresponding environment variables,
 * default value, type and optional plural name
 */
export interface Config {
  port: number;
  plugin?: string[];
  schemas_path: string;
  log_level: 'error' | 'warn' | 'notice' | 'info' | 'debug';
  shutdown_timeout?: number;
  debug: boolean;
  logger: 'console' | 'file';
  log_file?: string;
  api_prefix: string;
  mail_domain?: string[];
  // LDAP
  ldap_base?: string;
  ldap_dn?: string;
  ldap_pwd?: string;
  ldap_url?: string[];
  ldap_user_main_attribute?: string;
  ldap_cache_max?: number;
  ldap_cache_ttl?: number;
  ldap_pool_size?: number;
  ldap_connection_ttl?: number;
  user_class?: string[];

  // LDAP groups plugin
  ldap_group_base?: string;

  ldap_groups_main_attribute?: string;
  group_class?: string[];
  group_classes?: string[];
  group_default_attributes?: AttributesList;
  groups_allow_unexistent_members?: boolean;
  group_dummy_user?: string;
  group_schema?: string;

  /** Where core/metrics serves `GET /metrics` */
  metrics_port?: number;

  /**
   * Keyed storage, shared by whoever needs to keep something with a
   * deadline. `storage_backend` names the sub-plugin that keeps it; the rest
   * configures that one.
   */
  storage_backend?: string;
  storage_sweep_interval?: number;
  storage_ldap_base?: string;
  storage_ldap_object_class?: string;
  storage_file_directory?: string;
  storage_postgres_url?: string;
  storage_postgres_table?: string;
  storage_valkey_url?: string;
  storage_valkey_prefix?: string;

  // Back-Channel Logout. Where the marks live is core/storage's business;
  // what stays here is how long one is kept.
  bcl_retention?: number;

  // LDAP Organizations plugin
  ldap_top_organization?: string;
  ldap_organization_class?: string[];
  ldap_organization_link_attribute?: string;
  ldap_organization_path_attribute?: string;
  ldap_organization_path_separator?: string;
  ldap_organization_max_subnodes?: number;
  organization_schema?: string;

  // LDAP Flat generic plugin
  ldap_flat_schema?: string[];
  /** Add the auxiliary classes a modify needs, see ldapActions.classRepair */
  ldap_flat_auto_repair?: boolean;

  // LDAP enterprise rules plugin
  enterprise_domain_name_attribute?: string;
  enterprise_domain_link_attribute?: string;

  // LDAP raw (low-level browsing) plugin
  ldap_raw_base?: string[];
  ldap_raw_hidden_attribute?: string[];
  ldap_raw_show_secrets?: boolean;
  ldap_raw_max_results?: number;
  ldap_raw_schema_cache_ttl?: number;

  // LDAP Bulk Import plugin
  bulk_import_schemas?: string;
  bulk_import_max_file_size?: string;
  bulk_import_batch_size?: string;

  // External users in groups
  external_members_branch?: string;
  external_branch_class?: string[];

  // Static
  static_path?: string;
  static_name?: string;
  static_csp?: string;
  static_frame_options?: string;

  // auth (all authentication plugins)
  // A single prefix is accepted as a bare string: plugin overrides are raw
  // JSON (`{"auth_path_prefix":"/api/m"}`) and never go through the array
  // parsing that `--auth-path-prefix` and `DM_AUTH_PATH_PREFIX` apply
  auth_path_prefix?: string | string[];

  // auth/llng
  llng_ini?: string;
  llng_username_header?: string;

  // auth/token
  auth_token?: string[];

  // auth/fake
  auth_fake_user?: string;

  // auth/totp
  auth_totp?: string[];
  auth_totp_window?: number;
  auth_totp_step?: number;

  // auth/hmac
  auth_hmac?: string[];
  auth_hmac_window?: number;

  // auth/openidconnect
  oidc_server?: string;
  oidc_username_claim?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  base_url?: string;

  // auth/authzPerRoute
  authz_per_route?: string[];

  // auth/authzPerBranch
  /**
   * Judge an attached entry by the organization it hangs off rather than by
   * the branch it is stored in, and filter listings accordingly. Off by
   * default: where a branch is a tenant rather than a department, opening a
   * listing across branches is opening a door between customers.
   *
   * Honoured by `authzPerBranch`. `authzLinid1` always works this way, its
   * branches being organizations. `authzDynamic` extends `AuthBase` and
   * registers its own hooks, so it never sees the filter and this option does
   * nothing there.
   */
  authz_filter_attached_entries?: boolean;
  /**
   * The organization an administrator hands entries over through, when
   * entries are judged by their attachment: anyone administering a branch
   * sees what is attached there and may claim it, and puts an entry there
   * with write on the organization it leaves. An entry attached to no
   * organization is in transit too, with or without this option.
   */
  authz_transit_branch?: string;
  /**
   * The attribute an entry put in transit keeps the organization it leaves
   * in, removed when it is claimed: who claims it can tell where it comes
   * from. Empty records nothing. It must exist in the directory's schema.
   */
  authz_transit_origin_attribute?: string;
  authz_unresolved_user?: string;
  authz_identity?: string;
  /**
   * The authentication plugins, by instance name, whose requests an
   * authorization plugin judges. Empty means every one of them.
   */
  authz_for?: string[];
  /** Let two LDAP judges whose populations overlap compose as an AND. */
  authz_combine?: boolean;
  /** The branch-level plugin `authzScope` answers with, by instance name. */
  authz_scope_source?: string;
  authz_per_branch_config?: AuthConfig;
  authz_per_branch_cache_ttl?: number;

  // auth/authzDynamic (LDAP-backed tokens + per-branch ACL)
  authz_dynamic_base?: string;
  authz_dynamic_cache_ttl?: number;
  authz_dynamic_token_attribute?: string;
  authz_dynamic_config_attribute?: string;
  authz_dynamic_tenant_attribute?: string;
  authz_dynamic_reload_endpoint?: boolean;
  authz_dynamic_bypass?: string[];

  // auth/authzLinid1
  authz_local_admin_attribute?: string;
  /**
   * Branches outside the organization tree, such as the password policies,
   * that only the administrators of `authz_global_organization` read and
   * write
   */
  authz_global_branch?: string[];
  /**
   * Branches outside the organization tree, such as the mail domains, that
   * every administrator reads and only the administrators of
   * `authz_global_organization` write and delete in
   */
  authz_global_write_branch?: string[];
  /** The organization holding the global branches; the top one by default */
  authz_global_organization?: string;

  // auth/rateLimit
  rate_limit_window_ms?: number;
  rate_limit_max?: number;

  // auth/crowdsec
  crowdsec_url?: string;
  crowdsec_api_key?: string;
  crowdsec_cache_ttl?: number;

  // auth/trustedProxy
  trusted_proxy?: string[];
  trusted_proxy_auth_header?: string;

  // Special attributes
  mail_attribute?: string;
  quota_attribute?: string;
  delegation_attribute?: string;
  alias_attribute?: string;
  forward_attribute?: string;
  display_name_attribute?: string;
  drive_quota_attribute?: string;

  // James plugin
  james_webadmin_url?: string;
  james_webadmin_token?: string;
  james_signature_template?: string;
  ldap_concurrency?: number;
  james_concurrency?: number;
  james_init_delay?: number;
  james_retry_attempts?: number;
  james_retry_delay?: number;
  james_mailing_list_branch?: string[];
  james_mailbox_type_attribute?: string;
  james_sync_forwards?: boolean;
  james_team_mailbox_any_domain?: boolean;

  // Twake Mail migration proxy plugin
  migration_proxy_url?: string;
  migration_proxy_token?: string;
  migration_proxy_branch?: string[];
  migration_proxy_concurrency?: number;
  migration_proxy_retry_attempts?: number;
  migration_proxy_retry_delay?: number;

  // Drive (Cozy) plugin
  twake_drive_webadmin_url?: string;
  twake_drive_webadmin_token?: string;
  twake_drive_concurrency?: number;
  twake_drive_domain_attribute?: string;
  twake_drive_default_domain_template?: string;

  // Twake Calendar plugin
  calendar_webadmin_url?: string;
  calendar_webadmin_token?: string;
  calendar_concurrency?: number;
  calendar_resource_base?: string;
  calendar_resource_objectclass?: string;
  calendar_resource_creator?: string;
  calendar_resource_domain?: string;
  calendar_firstname_attribute?: string;
  calendar_lastname_attribute?: string;

  // Cozy provisioning plugin
  cozy_admin_url?: string;
  cozy_admin_user?: string;
  cozy_admin_passphrase?: string;
  cozy_org_id?: string;
  cozy_org_domain?: string;
  cozy_default_locale?: string;
  cozy_context_name?: string;
  cozy_apps?: string;
  cozy_auth_exchange?: string;
  cozy_b2b_exchange?: string;
  cozy_user_created_routing_key?: string;
  cozy_user_deleted_routing_key?: string;
  cloudery_manager_url?: string;
  cloudery_manager_token?: string;
  cloudery_offer?: string;
  cloudery_domain?: string;
  cloudery_user_branch?: string;
  cloudery_org_id_header?: string;
  cloudery_org_role_header?: string;
  cloudery_default_org_role?: string;
  cloudery_fqdn_attribute?: string;
  cloudery_org_id_attribute?: string;
  cloudery_org_role_attribute?: string;
  cloudery_phones_attribute?: string;
  cloudery_invited_attribute?: string;
  cloudery_default_locale?: string;
  cloudery_workflow_poll_interval_ms?: number;
  cloudery_workflow_max_attempts?: number;
  twake_lifecycle_role_attribute?: string;
  twake_lifecycle_lock_attribute?: string;
  twake_lifecycle_lock_value?: string;
  twake_lifecycle_deleted_attribute?: string;
  twake_lifecycle_deleted_value?: string;
  twake_lifecycle_deleted_at_attribute?: string;
  twake_lifecycle_deleted_at_format?: string;
  twake_lifecycle_rules?: string;
  twake_lifecycle_member_attribute?: string;
  twake_group_base?: string;
  twake_group_user_base?: string;
  twake_group_organization_dn?: string;
  twake_group_organization_status_attribute?: string;
  twake_group_organization_deleted_value?: string;
  twake_group_display_name_attribute?: string;
  twake_group_color_attribute?: string;
  twake_group_created_at_attribute?: string;
  twake_group_max_page_limit?: number;
  twake_group_member_fields?: Record<string, string>;
  twake_space_base?: string;
  twake_space_class?: string[];
  twake_space_display_name_attribute?: string;
  twake_space_admin_attribute?: string;
  twake_space_editor_attribute?: string;
  twake_space_viewer_attribute?: string;
  twake_space_user_role_attribute?: string;
  twake_space_exchange?: string;
  twake_space_sync_queue?: string;
  twake_instance_dn?: string[];
  twake_instance_skip_attribute?: string;
  twake_instance_skip_value?: string;
  twake_instance_provider?: string;
  twake_instance_id?: string;
  twake_instance_fqdn_attribute?: string;
  twake_instance_sent_attribute?: string;
  twake_instance_locale?: string;
  twake_instance_timeout?: number;
  twake_instance_cloudery_url?: string;
  twake_instance_cloudery_token?: string;
  twake_instance_cloudery_offer?: string;
  twake_instance_cloudery_domain?: string;
  twake_instance_cloudery_organization_offer?: string;
  twake_instance_cozy_url?: string;
  twake_instance_cozy_user?: string;
  twake_instance_cozy_passphrase?: string;
  twake_instance_cozy_domain?: string;
  twake_instance_cozy_context?: string;
  twake_instance_cozy_apps?: string;
  twake_instance_cozy_org_id?: string;
  twake_instance_cozy_org_domain?: string;
  twake_instance_auth_exchange?: string;
  twake_instance_b2b_exchange?: string;
  twake_instance_user_created_key?: string;
  twake_instance_organization_created_key?: string;
  twake_instance_workplace_created_key?: string;
  twake_instance_queue?: string;
  twake_instance_organization_base?: string;
  twake_instance_organization_id_attribute?: string;
  twake_instance_organization_domain_attribute?: string;
  twake_instance_organization_name_attribute?: string;
  twake_instance_organization_fqdn_attribute?: string;
  twake_lifecycle_reason_attribute?: string;
  twake_tombstone_dn?: string[];
  twake_tombstone_default_reason?: string;
  twake_tombstone_reason_header?: string;
  twake_tombstone_reasons?: string[];
  twake_tombstone_clear_attributes?: string[];
  twake_tombstone_erase_min_age?: number;
  twake_tombstone_group_bases?: string[];
  rabbitmq_url?: string;

  // Applicative Accounts plugin
  applicative_account_base?: string;
  max_app_accounts?: number;
  // LDAP attribute used to resolve the `:user` path param of the app-account
  // endpoints to the principal entry. Defaults to the mail attribute, which is
  // globally unique (see #88). Set to `uid` to restore the pre-#89 contract
  // where `:user` is the LDAP uid — only safe when uid is unique directory-wide.
  // Generated app-account uids are prefixed from this (unique) value, sanitized.
  app_accounts_user_attribute?: string;
  // Attributes copied from the user entry into the applicative entries. An
  // allowlist: anything not named here stays out, so a new attribute on the
  // user schema is never propagated by accident. The mail attribute is always
  // added to this set (it is what the applicative entry is keyed on).
  applicative_account_attribute?: string[];
  // Attributes dropped from an existing applicative entry when it is recreated
  // (mail change): the ones the directory generates and refuses on an `add`,
  // plus `userPassword` — an app account is reconfigured on every client after
  // a mail change anyway, so its password is deliberately not carried over.
  ldap_operational_attribute?: string[];

  // Trash plugin
  trash_base?: string;
  trash_watched_bases?: string;
  trash_add_metadata?: string;
  trash_auto_create?: string;

  // Password Policy plugin
  ppolicy_default_dn?: string;
  ppolicy_base?: string;
  ppolicy_warn_days?: number;
  ppolicy_validate_complexity?: boolean;
  ppolicy_min_length?: number;
  ppolicy_require_uppercase?: boolean;
  ppolicy_require_lowercase?: boolean;
  ppolicy_require_digit?: boolean;
  ppolicy_require_special?: boolean;
  ldap_users_base?: string;

  // SCIM plugin
  scim_prefix?: string;
  scim_user_base?: string;
  scim_group_base?: string;
  scim_user_base_template?: string;
  scim_group_base_template?: string;
  scim_user_base_header?: string;
  scim_group_base_header?: string;
  scim_base_header_root?: string;
  scim_base_map?: string;
  scim_user_object_class?: string[];
  scim_user_rdn_attribute?: string;
  scim_user_lock_attribute?: string;
  scim_user_lock_value?: string;
  scim_group_object_class?: string[];
  scim_group_rdn_attribute?: string;
  scim_group_external_id_attribute?: string;
  scim_id_attribute?: string;
  scim_user_mapping?: string;
  scim_group_mapping?: string;
  scim_max_results?: number;
  scim_max_scanned?: number;
  scim_bulk_max_operations?: number;
  scim_bulk_max_payload_size?: number;
  scim_etag?: boolean;
  scim_base_url?: string;

  // Accept additional config keys for non core plugins
  [key: string]:
    | string
    | string[]
    | boolean
    | number
    | AttributesList
    | AuthConfig
    | undefined;
}

/**
 * Config arguments
 *
 * Format:
 * [ command-line-option, env-variable, default-value, type?, plural? ]
 *
 * type can be one of:
 * - string (default value)
 * - boolean:
 *    * --option is enough
 *    * env variable must be set to "true" to be considered as truthy
 * - number
 * - json: parameter s a string that will be converted into an object during configuration parsing
 *
 * Additional command-line:
 * to permit to non-core plugin to use command-line, all command-line pairs `--key-name value`
 * are stored into config (string only) as `config.key_name = value`
 */
const configArgs: ConfigTemplate = [
  // Global options
  ['--port', 'DM_PORT', 8081, 'number'],
  ['--shutdown-timeout', 'DM_SHUTDOWN_TIMEOUT', 20000, 'number'],
  ['--plugin', 'DM_PLUGINS', [], 'array', '--plugins', 'identifiers'],
  ['--log-level', 'DM_LOG_LEVEL', 'notice'],
  ['--logger', 'DM_LOGGER', 'console'],
  ['--debug', 'DM_DEBUG', false, 'boolean'],
  ['--log-file', 'DM_LOG_FILE', 'error.log'],
  ['--api-prefix', 'DM_API_PREFIX', '/api'],
  [
    '--mail-domain',
    'DM_MAIL_DOMAIN',
    [],
    'array',
    '--mail-domains',
    'identifiers',
  ],

  // LDAP options
  ['--ldap-base', 'DM_LDAP_BASE', ''],
  ['--ldap-dn', 'DM_LDAP_DN', ''],
  ['--ldap-pwd', 'DM_LDAP_PWD', ''],
  [
    '--ldap-url',
    'DM_LDAP_URL',
    ['ldap://localhost'],
    'array',
    '--ldap-urls',
    'identifiers',
    true,
  ],
  ['--ldap-user-main-attribute', 'DM_LDAP_USER_ATTRIBUTE', 'uid'],
  ['--ldap-cache-max', 'DM_LDAP_CACHE_MAX', 1000, 'number'],
  // 0 means "do not cache", and it is the default: the base-scope search
  // cache stored nothing at all until #166, so no deployment has ever run
  // with it on. See ldapActions' constructor.
  ['--ldap-cache-ttl', 'DM_LDAP_CACHE_TTL', 0, 'number'], // seconds, 0 = off
  ['--ldap-pool-size', 'DM_LDAP_POOL_SIZE', 5, 'number'],
  ['--ldap-connection-ttl', 'DM_LDAP_CONNECTION_TTL', 60, 'number'], // seconds
  [
    '--schemas-path',
    'DM_SCHEMAS_PATH',
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'static',
      'schemas'
    ),
  ],

  // Special attributes
  ['--mail-attribute', 'DM_MAIL_ATTRIBUTE', 'mail'],
  ['--quota-attribute', 'DM_QUOTA_ATTRIBUTE', 'mailQuotaSize'],
  ['--delegation-attribute', 'DM_DELEGATION_ATTRIBUTE', 'twakeDelegatedUsers'],
  ['--alias-attribute', 'DM_ALIAS_ATTRIBUTE', 'mailAlternateAddress'],
  ['--forward-attribute', 'DM_FORWARD_ATTRIBUTE', 'mailForwardingAddress'],
  ['--display-name-attribute', 'DM_DISPLAY_NAME_ATTRIBUTE', 'displayName'],
  ['--drive-quota-attribute', 'DM_DRIVE_QUOTA_ATTRIBUTE', 'twakeDriveQuota'],

  // Default classes to insert into LDAP
  [
    '--user-class',
    'DM_USER_CLASSES',
    ['top', 'twakeAccount', 'twakeWhitePages'],
    'array',
    '--user-classes',
    'identifiers',
  ],

  // Plugins options

  // LDAP organizations
  ['--ldap-top-organization', 'DM_LDAP_TOP_ORGANIZATION', ''],
  [
    '--ldap-organization-class',
    'DM_LDAP_ORGANIZATION_CLASSES',
    ['top', 'organizationalUnit', 'twakeDepartment'],
    'array',
    '--ldap-organization-classes',
    'identifiers',
  ],
  [
    '--ldap-organization-link-attribute',
    'DM_LDAP_ORGANIZATION_LINK_ATTRIBUTE',
    'twakeDepartmentLink',
  ],
  [
    '--ldap-organization-path-attribute',
    'DM_LDAP_ORGANIZATION_PATH_ATTRIBUTE',
    'twakeDepartmentPath',
  ],
  [
    '--ldap-organization-path-separator',
    'DM_LDAP_ORGANIZATION_PATH_SEPARATOR',
    ' / ',
  ],
  [
    '--ldap-organization-max-subnodes',
    'DM_LDAP_ORGANIZATION_MAX_SUBNODES',
    50,
    'number',
  ],
  // No default: loading a schema turns on validation the organizations plugin
  // does not perform otherwise, so it stays an explicit choice.
  ['--organization-schema', 'DM_ORGANIZATION_SCHEMA', ''],

  // LDAP enterprise rules plugin

  [
    '--enterprise-domain-name-attribute',
    'DM_ENTERPRISE_DOMAIN_NAME_ATTRIBUTE',
    'associatedDomain',
  ],
  [
    '--enterprise-domain-link-attribute',
    'DM_ENTERPRISE_DOMAIN_LINK_ATTRIBUTE',
    '',
  ],

  // Metrics plugin
  ['--metrics-port', 'DM_METRICS_PORT', 9464, 'number'],

  // Keyed storage
  //
  // Which sub-plugin keeps the records: `ldap`, `file`, `postgres` or
  // `valkey`. Empty means none is loaded, and a consumer asking for one says
  // so.
  ['--storage-backend', 'DM_STORAGE_BACKEND', ''],
  // Reads enforce expiry whatever the sweeper has done, so a long interval
  // costs storage rather than correctness — with one exception: `file` will
  // not sweep a temporary younger than this, so an interval shorter than a
  // write takes would make it take one in flight.
  ['--storage-sweep-interval', 'DM_STORAGE_SWEEP_INTERVAL', 600, 'number'],
  // The branch `storage/ldap` writes to. It holds records and nothing else,
  // so it belongs outside the branches the directory serves.
  ['--storage-ldap-base', 'DM_STORAGE_LDAP_BASE', ''],
  [
    '--storage-ldap-object-class',
    'DM_STORAGE_LDAP_OBJECT_CLASS',
    'applicationProcess',
  ],
  // The directory `storage/file` writes to, one file per record, so nothing
  // else should be writing there.
  ['--storage-file-directory', 'DM_STORAGE_FILE_DIRECTORY', ''],
  ['--storage-postgres-url', 'DM_STORAGE_POSTGRES_URL', ''],
  [
    '--storage-postgres-table',
    'DM_STORAGE_POSTGRES_TABLE',
    'ldap_rest_storage',
  ],
  // The instance must not evict: see docs/usage/plugins/utilities/storage.md.
  ['--storage-valkey-url', 'DM_STORAGE_VALKEY_URL', ''],
  ['--storage-valkey-prefix', 'DM_STORAGE_VALKEY_PREFIX', 'ldap-rest:'],

  // Back-Channel Logout
  //
  // How long a tombstone is kept. It has to outlive the session it kills, or
  // a cookie older than the mark would be honoured again; the default matches
  // express-openid-connect's own 7-day session. Where the marks live, and how
  // often expired ones are reclaimed, is core/storage's business.
  ['--bcl-retention', 'DM_BCL_RETENTION', 604800, 'number'],

  // LDAP groups plugin

  ['--ldap-group-base', 'DM_LDAP_GROUP_BASE', ''],
  ['--ldap-groups-main-attribute', 'DM_LDAP_GROUPS_MAIN_ATTRIBUTE', 'cn'],
  [
    '--group-class',
    'DM_GROUP_CLASSES',
    ['top', 'groupOfNames'],
    'array',
    '--group-classes',
    'identifiers',
  ],
  [
    '--group-allow-unexistent-members',
    'DM_ALLOW_UNEXISTENT_MEMBERS',
    false,
    'boolean',
  ],
  ['--group-default-attributes', 'DM_GROUP_DEFAULT_ATTRIBUTES', {}, 'json'],
  ['--group-dummy-user', 'DM_GROUP_DUMMY_USER', 'cn=fakeuser'],
  [
    '--group-schema',
    'DM_GROUP_SCHEMA',
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'static',
      'schemas',
      'twake',
      'groups.json'
    ),
  ],

  // externalUsersInGroups

  [
    '--external-members-branch',
    'DM_EXTERNAL_MEMBERS_BRANCH',
    'ou=contacts,dc=example,dc=com',
  ],
  [
    '--external-branch-class',
    'DM_EXTERNAL_BRANCH_CLASSES',
    ['top', 'inetOrgPerson'],
    'array',
    '--external-branch-classes',
    'identifiers',
  ],

  // static
  [
    '--static-path',
    'DM_STATIC_PATH',
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'static'),
  ],
  ['--static-name', 'DM_STATIC_NAME', 'static'],
  // An administration page is not to be framed by another site
  // (clickjacking): see core/static, `off` sends no header
  ['--static-csp', 'DM_STATIC_CSP', STATIC_CSP],
  ['--static-frame-options', 'DM_STATIC_FRAME_OPTIONS', STATIC_FRAME_OPTIONS],

  // LDAP Flat generic plugin
  [
    '--ldap-flat-schema',
    'DM_LDAP_FLAT_SCHEMA',
    [],
    'array',
    '--ldap-flat-schemas',
  ],
  ['--ldap-flat-auto-repair', 'DM_LDAP_FLAT_AUTO_REPAIR', true, 'boolean'],

  // LDAP raw (low-level browsing) plugin
  [
    '--ldap-raw-base',
    'DM_LDAP_RAW_BASE',
    [],
    'array',
    '--ldap-raw-bases',
    'dns',
  ],
  [
    '--ldap-raw-hidden-attribute',
    'DM_LDAP_RAW_HIDDEN_ATTRIBUTES',
    [],
    'array',
    '--ldap-raw-hidden-attributes',
    'identifiers',
  ],
  ['--ldap-raw-show-secrets', 'DM_LDAP_RAW_SHOW_SECRETS', false, 'boolean'],
  ['--ldap-raw-max-results', 'DM_LDAP_RAW_MAX_RESULTS', 200, 'number'],
  [
    '--ldap-raw-schema-cache-ttl',
    'DM_LDAP_RAW_SCHEMA_CACHE_TTL',
    3600,
    'number',
  ], // seconds

  // LDAP Bulk Import plugin
  ['--bulk-import-schemas', 'DM_BULK_IMPORT_SCHEMAS', ''],
  ['--bulk-import-max-file-size', 'DM_BULK_IMPORT_MAX_FILE_SIZE', '10485760'],
  ['--bulk-import-batch-size', 'DM_BULK_IMPORT_BATCH_SIZE', '100'],

  // James plugin
  ['--ldap-concurrency', 'DM_LDAP_CONCURRENCY', 10, 'number'],
  ...toConfigEntries(jamesOptions),

  // Twake Mail migration proxy plugin
  ...toConfigEntries(migrationProxyOptions),

  // Drive (Cozy) plugin
  ...toConfigEntries(driveOptions),

  // Twake Calendar plugin
  ...toConfigEntries(calendarOptions),

  // Cozy provisioning plugin (twake/cozyProvision)
  ...toConfigEntries(cozyOptions),

  // clouderyProvision plugin
  ...toConfigEntries(clouderyOptions),

  // Account lifecycle, groups, spaces and tombstone options
  ...toConfigEntries(twakeLifecycleOptions),
  ...toConfigEntries(twakeGroupsOptions),
  ...toConfigEntries(twakeSpacesOptions),
  ...toConfigEntries(twakeTombstoneOptions),

  // twake/instances plugin
  ...toConfigEntries(twakeInstancesOptions),

  ['--rabbitmq-url', 'DM_RABBITMQ_URL', ''],

  // Applicative Accounts plugin
  ...toConfigEntries(appAccountsOptions),

  // Trash plugin
  ['--trash-base', 'DM_TRASH_BASE', ''],
  ['--trash-watched-bases', 'DM_TRASH_WATCHED_BASES', ''],
  ['--trash-add-metadata', 'DM_TRASH_ADD_METADATA', 'true'],
  ['--trash-auto-create', 'DM_TRASH_AUTO_CREATE', 'true'],

  /* Access control plugins */

  // Lemonldap options
  ['--llng-ini', 'DM_LLNG_INI', '/etc/lemonldap-ng/lemonldap-ng.ini'],
  // A header LemonLDAP::NG exports carrying the caller's login, published as
  // `req.userName`. Empty means none, and `whatToTrace` — the value the
  // handler writes to `Lm-Remote-User` — is then both values. Configure it
  // when `whatToTrace` traces a mail or a display name and rules are to be
  // written on logins (`--authz-identity req.userName`).
  ['--llng-username-header', 'DM_LLNG_USERNAME_HEADER', ''],

  // Common to every authentication plugin: restrict it to path prefixes
  [
    '--auth-path-prefix',
    'DM_AUTH_PATH_PREFIX',
    [],
    'array',
    '--auth-path-prefixes',
  ],

  // Auth token plugin
  ['--auth-token', 'DM_AUTH_TOKENS', [], 'array', '--auth-tokens'],

  // Auth fake plugin
  ['--auth-fake-user', 'DM_AUTH_FAKE_USER', ''],

  // Auth TOTP plugin
  ['--auth-totp', 'DM_AUTH_TOTP', [], 'array', '--auth-totps', 'phrases'],
  ['--auth-totp-window', 'DM_AUTH_TOTP_WINDOW', 1, 'number'],
  ['--auth-totp-step', 'DM_AUTH_TOTP_STEP', 30, 'number'],

  // Auth HMAC plugin
  ['--auth-hmac', 'DM_AUTH_HMAC', [], 'array', '--auth-hmacs', 'phrases'],
  ['--auth-hmac-window', 'DM_AUTH_HMAC_WINDOW', 120000, 'number'],

  // Auth authzPerRoute plugin
  [
    '--authz-per-route',
    'DM_AUTHZ_PER_ROUTES',
    [],
    'array',
    '--authz-per-routes',
  ],

  // Common to every authorization plugin
  //
  // What an *authenticated* caller whose identity the plugin cannot resolve
  // means. `deny` refuses the operation; `allow` lets it through with a
  // warning, which is what every plugin did until it turned out to be an
  // open door: `authzLinid1` resolves `req.user` as a `uid` in the
  // directory, so an authenticator publishing something else — an OIDC
  // `sub`, an LLNG `whatToTrace` tracing a mail — made every check skip,
  // across the whole tree. An anonymous request is not this case: it is
  // skipped as before.
  ['--authz-unresolved-user', 'DM_AUTHZ_UNRESOLVED_USER', 'deny'],
  // Which of the two values an authenticator publishes the authorization
  // plugins key on: `req.user`, this server's identifier for the caller, or
  // `req.userName`, the caller under a name a person would use. The default
  // keeps every existing rule meaning what it meant.
  ['--authz-identity', 'DM_AUTHZ_IDENTITY', 'req.user'],
  // Whose requests an authorization plugin judges: the instance names of the
  // authentication plugins that vouched for them. Empty — the default —
  // means every authenticated request, whatever authenticated it, which is
  // what every plugin did before the option existed. Meant for a plugin's
  // own overrides (`{"authz_for":["oidc"]}`), so a branch model written for
  // administrators does not judge a machine token it cannot name.
  ['--authz-for', 'DM_AUTHZ_FOR', [], 'array', null, 'identifiers'],
  // Two plugins judging the LDAP operations of the same requests compose as
  // an AND: the first refusal wins. The server refuses to start on that
  // unless this says the AND is meant.
  ['--authz-combine', 'DM_AUTHZ_COMBINE', false, 'boolean'],
  // The branch-level plugin `authzScope` describes a caller with, when more
  // than one of them judges that caller. Empty: the first one loaded, and
  // the answer lists the others under `sources`.
  ['--authz-scope-source', 'DM_AUTHZ_SCOPE_SOURCE', ''],

  // Auth authzPerBranch plugin
  [
    '--authz-filter-attached-entries',
    'DM_AUTHZ_FILTER_ATTACHED_ENTRIES',
    false,
    'boolean',
  ],
  ['--authz-transit-branch', 'DM_AUTHZ_TRANSIT_BRANCH', ''],
  ['--authz-transit-origin-attribute', 'DM_AUTHZ_TRANSIT_ORIGIN_ATTRIBUTE', ''],
  [
    '--authz-per-branch-config',
    'DM_AUTHZ_PER_BRANCH_CONFIG',
    { default: { read: true, write: false, delete: false } } as AuthConfig,
    'json',
  ],
  [
    '--authz-per-branch-cache-ttl',
    'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    60,
    'number',
  ],

  // Auth authzDynamic plugin
  //
  // Who may reach the directory through this plugin without presenting one
  // of its tokens. Empty — the default — means nobody: a request is checked
  // against the ACLs of the token it carries, whatever else authenticated
  // it. Values are identities as another authenticator publishes them in
  // `req.user`, plus two words:
  //
  //  - `any-authenticated`: anything another plugin authenticated, which is
  //    what the plugin did until 0.9.0, by accident rather than by decision;
  //  - `trusted-proxy`: a request `core/auth/trustedProxy` vouched for.
  [
    '--authz-dynamic-bypass',
    'DM_AUTHZ_DYNAMIC_BYPASS',
    [],
    'array',
    null,
    'identifiers',
  ],
  ['--authz-dynamic-base', 'DM_AUTHZ_DYNAMIC_BASE', ''],
  ['--authz-dynamic-cache-ttl', 'DM_AUTHZ_DYNAMIC_CACHE_TTL', 60, 'number'],
  [
    '--authz-dynamic-token-attribute',
    'DM_AUTHZ_DYNAMIC_TOKEN_ATTRIBUTE',
    'userPassword',
  ],
  [
    '--authz-dynamic-config-attribute',
    'DM_AUTHZ_DYNAMIC_CONFIG_ATTRIBUTE',
    'description',
  ],
  [
    '--authz-dynamic-tenant-attribute',
    'DM_AUTHZ_DYNAMIC_TENANT_ATTRIBUTE',
    'cn',
  ],
  [
    '--authz-dynamic-reload-endpoint',
    'DM_AUTHZ_DYNAMIC_RELOAD_ENDPOINT',
    false,
    'boolean',
  ],

  // Auth authzLinid1 plugin
  [
    '--authz-local-admin-attribute',
    'DM_AUTHZ_LOCAL_ADMIN_ATTRIBUTE',
    'twakeLocalAdminLink',
  ],
  [
    '--authz-global-branch',
    'DM_AUTHZ_GLOBAL_BRANCHES',
    [],
    'array',
    '--authz-global-branches',
    'dns',
  ],
  [
    '--authz-global-write-branch',
    'DM_AUTHZ_GLOBAL_WRITE_BRANCHES',
    [],
    'array',
    '--authz-global-write-branches',
    'dns',
  ],
  ['--authz-global-organization', 'DM_AUTHZ_GLOBAL_ORGANIZATION', ''],

  // Auth OpenID Connect plugin
  ['--oidc-server', 'DM_OIDC_SERVER', ''],
  // Which claim names the caller for a human reader. The `sub` is what
  // authorization rules are keyed on by default, and it is an opaque
  // provider identifier — `auth0|…`, a UUID — that nobody can write a rule
  // for without looking it up per administrator. This claim is published as
  // `req.userName`, which `--authz-identity` can key on instead.
  ['--oidc-username-claim', 'DM_OIDC_USERNAME_CLAIM', 'sub'],
  ['--oidc-client-id', 'DM_OIDC_CLIENT_ID', ''],
  ['--oidc-client-secret', 'DM_OIDC_CLIENT_SECRET', ''],
  ['--base-url', 'DM_BASE_URL', ''],

  // Rate limiting plugin
  [
    '--rate-limit-window-ms',
    'DM_RATE_LIMIT_WINDOW_MS',
    15 * 60 * 1000,
    'number',
  ],
  ['--rate-limit-max', 'DM_RATE_LIMIT_MAX', 100, 'number'],

  // CrowdSec plugin
  ['--crowdsec-url', 'DM_CROWDSEC_URL', 'http://localhost:8080/v1/decisions'],
  ['--crowdsec-api-key', 'DM_CROWDSEC_API_KEY', ''],
  ['--crowdsec-cache-ttl', 'DM_CROWDSEC_CACHE_TTL', 60, 'number'],

  // Trusted proxy plugin
  [
    '--trusted-proxy',
    'DM_TRUSTED_PROXIES',
    [],
    'array',
    '--trusted-proxies',
    'identifiers',
  ],
  ['--trusted-proxy-auth-header', 'DM_TRUSTED_PROXY_AUTH_HEADER', 'Auth-User'],

  // Password Policy plugin
  ['--ppolicy-default-dn', 'DM_PPOLICY_DEFAULT_DN', ''],
  ['--ppolicy-base', 'DM_PPOLICY_BASE', ''],
  ['--ppolicy-warn-days', 'DM_PPOLICY_WARN_DAYS', 14, 'number'],
  [
    '--ppolicy-validate-complexity',
    'DM_PPOLICY_VALIDATE_COMPLEXITY',
    false,
    'boolean',
  ],
  ['--ppolicy-min-length', 'DM_PPOLICY_MIN_LENGTH', 12, 'number'],
  [
    '--ppolicy-require-uppercase',
    'DM_PPOLICY_REQUIRE_UPPERCASE',
    true,
    'boolean',
  ],
  [
    '--ppolicy-require-lowercase',
    'DM_PPOLICY_REQUIRE_LOWERCASE',
    true,
    'boolean',
  ],
  ['--ppolicy-require-digit', 'DM_PPOLICY_REQUIRE_DIGIT', true, 'boolean'],
  ['--ppolicy-require-special', 'DM_PPOLICY_REQUIRE_SPECIAL', true, 'boolean'],
  ['--ldap-users-base', 'DM_LDAP_USERS_BASE', ''],

  // SCIM plugin
  ...toConfigEntries(scimOptions),
];

export default configArgs;
