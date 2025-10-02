/**
 * command-line options, corresponding environment variables, default values and types
 * Contains also the typescript declaration of config
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { AttributesList } from '../lib/ldapActions';
import type { ConfigTemplate } from '../lib/parseConfig';

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
  logger: 'console';
  api_prefix: string;
  mail_domain?: string[];
  // LDAP
  ldap_base?: string;
  ldap_dn?: string;
  ldap_pwd?: string;
  ldap_url?: string;
  ldap_user_main_attribute?: string;
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

  // LDAP Organizations plugin
  ldap_top_organization?: string;
  ldap_organization_class?: string[];
  ldap_organization_link_attribute?: string;
  ldap_organization_path_attribute?: string;
  ldap_organization_path_separator?: string;

  // LDAP Flat generic plugin
  ldap_flat_schema?: string[];

  // External users in groups
  external_members_branch?: string;
  external_branch_class?: string[];

  // Static
  static_path?: string;
  static_name?: string;

  // auth/llng
  llng_ini?: string;

  // auth/token
  auth_token?: string[];

  // auth/openidconnect
  oidc_server?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  base_url?: string;

  // Special attributes
  mail_attribute?: string;
  quota_attribute?: string;

  // James plugin
  james_webadmin_url?: string;
  james_webadmin_token?: string;

  // Accept additional config keys for non core plugins
  [key: string]:
    | string
    | string[]
    | boolean
    | number
    | AttributesList
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
  ['--plugin', 'DM_PLUGINS', [], 'array', '--plugins'],
  ['--log-level', 'DM_LOG_LEVEL', 'info'],
  ['--logger', 'DM_LOGGER', 'console'],
  ['--api-prefix', 'DM_API_PREFIX', '/api'],
  ['--mail-domain', 'DM_MAIL_DOMAIN', [], 'array', '--mail-domains'],

  // LDAP options
  ['--ldap-base', 'DM_LDAP_BASE', ''],
  ['--ldap-dn', 'DM_LDAP_DN', 'cn=admin,dc=example,dc=com'],
  ['--ldap-pwd', 'DM_LDAP_PWD', 'admin'],
  ['--ldap-url', 'DM_LDAP_URL', 'ldap://localhost'],
  ['--ldap-user-main-attribute', 'DM_LDAP_USER_ATTRIBUTE', 'uid'],
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
  ['--quota-attribute', 'DM_QUOTA_ATTRIBUTE', 'mailQuota'],

  // Default classes to insert into LDAP
  [
    '--user-class',
    'DM_USER_CLASSES',
    ['top', 'twakeAccount', 'twakeWhitePages'],
    'array',
    '--user-classes',
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

  // LDAP groups plugin

  ['--ldap-group-base', 'DM_LDAP_GROUP_BASE', ''],
  ['--ldap-groups-main-attribute', 'DM_LDAP_GROUPS_MAIN_ATTRIBUTE', 'cn'],
  [
    '--group-class',
    'DM_GROUP_CLASSES',
    ['top', 'groupOfNames'],
    'array',
    '--group-classes',
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
  ],

  // static
  [
    '--static-path',
    'DM_STATIC_PATH',
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'static'),
  ],
  ['--static-name', 'DM_STATIC_NAME', 'static'],

  // LDAP Flat generic plugin
  [
    '--ldap-flat-schema',
    'DM_LDAP_FLAT_SCHEMA',
    [],
    'array',
    '--ldap-flat-schemas',
  ],

  // James plugin
  ['--james-webadmin-url', 'DM_JAMES_WEBADMIN_URL', 'http://localhost:8000'],
  ['--james-webadmin-token', 'DM_JAMES_WEBADMIN_TOKEN', ''],

  /* Access control plugins */

  // Lemonldap options
  ['--llng-ini', 'DM_LLNG_INI', '/etc/lemonldap-ng/lemonldap-ng.ini'],

  // Auth token plugin
  ['--auth-token', 'DM_AUTH_TOKENS', [], 'array', '--auth-tokens'],

  // Auth OpenID Connect plugin
  ['--oidc-server', 'DM_OIDC_SERVER', ''],
  ['--oidc-client-id', 'DM_OIDC_CLIENT_ID', ''],
  ['--oidc-client-secret', 'DM_OIDC_CLIENT_SECRET', ''],
  ['--base-url', 'DM_BASE_URL', ''],
];

export default configArgs;
