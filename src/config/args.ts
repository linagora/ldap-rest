/**
 * command-line options, corresponding environment variables, default values and types
 * Contains also the typescript declaration of config
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { AttributesList } from '../lib/ldapActions';
import type { ConfigTemplate } from '../lib/parseConfig';
import { bclOptions } from '../plugins/bcl.options';
import { rabbitmqOptions } from '../plugins/rabbitmq.options';
import { metricsOptions } from '../plugins/metrics.options';
import { storageOptions } from '../plugins/storage.options';
import { staticOptions } from '../plugins/static.options';
import { scimOptions } from '../plugins/scim/scim.options';
import {
  crowdsecOptions,
  dynamicOptions,
  fakeOptions,
  hmacOptions,
  linid1Options,
  llngOptions,
  openidconnectOptions,
  perBranchOptions,
  perRouteOptions,
  rateLimitOptions,
  tokenOptions,
  totpOptions,
  trustedProxyOptions,
} from '../plugins/auth/auth.options';
import {
  bulkImportOptions,
  enterpriseRulesOptions,
  externalUsersOptions,
  flatGenericOptions,
  groupsOptions,
  organizationOptions,
  passwordPolicyOptions,
  rawOptions,
  trashOptions,
} from '../plugins/ldap/ldap.options';
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

export { STATIC_CSP, STATIC_FRAME_OPTIONS } from '../plugins/static.options';

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
  strict_options?: boolean;
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
  ['--strict-options', 'DM_STRICT_OPTIONS', false, 'boolean'],
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
  ...toConfigEntries(organizationOptions),

  // LDAP enterprise rules plugin
  ...toConfigEntries(enterpriseRulesOptions),

  // Metrics, keyed storage and Back-Channel Logout plugins
  ...toConfigEntries(metricsOptions),
  ...toConfigEntries(storageOptions),
  ...toConfigEntries(bclOptions),

  // LDAP groups and external users plugins
  ...toConfigEntries(groupsOptions),
  ...toConfigEntries(externalUsersOptions),

  // static
  ...toConfigEntries(staticOptions),

  // LDAP flat, raw and bulk import plugins
  ...toConfigEntries(flatGenericOptions),
  ...toConfigEntries(rawOptions),
  ...toConfigEntries(bulkImportOptions),

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

  ...toConfigEntries(rabbitmqOptions),

  // Applicative Accounts plugin
  ...toConfigEntries(appAccountsOptions),

  // Trash plugin
  ...toConfigEntries(trashOptions),

  /* Access control plugins */

  // Lemonldap options
  ...toConfigEntries(llngOptions),

  // Common to every authentication plugin: restrict it to path prefixes
  [
    '--auth-path-prefix',
    'DM_AUTH_PATH_PREFIX',
    [],
    'array',
    '--auth-path-prefixes',
  ],

  // Auth token, fake, TOTP and HMAC plugins
  ...toConfigEntries(tokenOptions),
  ...toConfigEntries(fakeOptions),
  ...toConfigEntries(totpOptions),
  ...toConfigEntries(hmacOptions),

  // Auth authzPerRoute plugin
  ...toConfigEntries(perRouteOptions),

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
  ...toConfigEntries(perBranchOptions),

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
  ...toConfigEntries(dynamicOptions),

  // Auth authzLinid1 plugin
  ...toConfigEntries(linid1Options),

  // Auth OpenID Connect plugin
  ...toConfigEntries(openidconnectOptions),

  // Rate limiting, CrowdSec and trusted proxy plugins
  ...toConfigEntries(rateLimitOptions),
  ...toConfigEntries(crowdsecOptions),
  ...toConfigEntries(trustedProxyOptions),

  // Password Policy plugin
  ...toConfigEntries(passwordPolicyOptions),

  // SCIM plugin
  ...toConfigEntries(scimOptions),
];

export default configArgs;
