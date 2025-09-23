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
  auth?: string;

  // LDAP
  top_dn?: string;
  ldap_base?: string;
  ldap_dn?: string;
  llng_ini?: string;
  ldap_pwd?: string;
  ldap_url?: string;
  plugin?: string[];
  plugins?: string;
  user_class?: string[];
  user_classes?: string;

  // LDAP groups plugin
  ldap_group_base?: string;
  group_class?: string[];
  group_classes?: string[];
  group_default_attributes?: AttributesList;
  groups_allow_unexistent_members?: boolean;
  group_dummy_user?: string;

  // External users in groups
  external_members_branch?: string;

  // Static
  static_path?: string;
  static_name?: string;

  // Special attributes
  mail_attribute?: string;

  // Accept additional config keys for non core plugins
  [key: string]:
    | string
    | string[]
    | boolean
    | number
    | AttributesList
    | undefined;
}

/*
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
  ['--auth', 'DM_AUTH', ''],
  ['--plugin', 'DM_PLUGINS', [], 'array', '--plugins'],

  // LDAP options
  ['--ldap-base', 'DM_LDAP_BASE', ''],
  ['--ldap-dn', 'DM_LDAP_DN', 'cn=admin,dc=example,dc=org'],
  ['--ldap-pwd', 'DM_LDAP_PWD', 'admin'],
  ['--ldap-url', 'DM_LDAP_URL', 'ldap://localhost'],
  ['--top-dn', 'DM_TOP_DN', 'dc=example,dc=com'],

  // Special attributes
  ['--mail-attribute', 'DM_MAIL_ATTRIBUTE', 'mail'],

  // Default classes to insert into LDAP
  [
    '--user-class',
    'DM_USER_CLASSES',
    ['top', 'inetOrgPerson'],
    'array',
    '--user-classes',
  ],

  // Plugins options
  // LDAP groups plugin

  ['--ldap-group-base', 'DM_LDAP_GROUP_BASE', ''],
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

  // externalUsersInGroups

  [
    '--external-members-branch',
    'DM_EXTERNAL_MEMBERS_BRANCH',
    'ou=contacts,dc=example,dc=com',
  ],

  // static
  ['--static-path', 'DM_STATIC_PATH', ''],
  ['--static-name', 'DM_STATIC_NAME', 'static'],

  // Authentication options
  // Lemonldap options

  ['--llng-ini', 'DM_LLNG_INI', '/etc/lemonldap-ng/lemonldap-ng.ini'],
];

export default configArgs;
