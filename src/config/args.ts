import type { AttributesList } from '../lib/ldapActions';
import type { ConfigTemplate } from '../lib/parseConfig';

export interface Config {
  port: number;
  auth?: string;

  // LDAP
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
  group_dummy_user?: string

  // Accept additional config keys for non core plugins
  [key: string]:
    | string
    | string[]
    | boolean
    | number
    | AttributesList
    | undefined;
}

const configArgs: ConfigTemplate = [
  // Global options
  {
    cliArg: '--port',
    envVar: 'DM_PORT',
    defaultValue: 8081,
    type: 'number',
  },
  {
    cliArg: '--auth',
    envVar: 'DM_AUTH',
    defaultValue: '',
  },
  // NB: this automatically declares a --plugins arg as well
  {
    cliArg: '--plugin',
    envVar: 'DM_PLUGINS',
    defaultValue: [],
    type: 'array',
    plural: '--plugins',
  },

  // LDAP options
  {
    cliArg: '--ldap-base',
    envVar: 'DM_LDAP_BASE',
    defaultValue: '',
  },
  {
    cliArg: '--ldap-dn',
    envVar: 'DM_LDAP_DN',
    defaultValue: 'cn=admin,dc=example,dc=org',
  },
  {
    cliArg: '--ldap-pwd',
    envVar: 'DM_LDAP_PWD',
    defaultValue: 'admin',
  },
  {
    cliArg: '--ldap-url',
    envVar: 'DM_LDAP_URL',
    defaultValue: 'ldap://localhost',
  },
  // Special attributes
  {
    cliArg: '--mail-attribute',
    envVar: 'DM_MAIL_ATTRIBUTE',
    defaultValue: 'mail',
  },
  // Default classes to insert into LDAP
  {
    cliArg: '--user-class',
    envVar: 'DM_USER_CLASSES',
    defaultValue: ['top', 'inetOrgPerson'],
    type: 'array',
    plural: '--user-classes',
  },

  // Plugins options

  // LDAP groups plugin
  {
    cliArg: '--ldap-group-base',
    envVar: 'DM_LDAP_GROUP_BASE',
    defaultValue: '',
  },
  {
    cliArg: '--group-class',
    envVar: 'DM_GROUP_CLASSES',
    defaultValue: ['top', 'groupOfNames'],
    type: 'array',
    plural: '--group-classes',
  },
  {
    cliArg: '--group-allow-unexistent-members',
    envVar: 'DM_ALLOW_UNEXISTENT_MEMBERS',
    defaultValue: false,
    type: 'boolean',
  },
  {
    cliArg: '--group-default-attributes',
    envVar: 'DM_GROUP_DEFAULT_ATTRIBUTES',
    defaultValue: {},
    type: 'json',
  },
  {
    cliArg: '--group-dummy-user',
    envVar: 'DM_GROUP_DUMMY_USER',
    defaultValue: 'cn=fakeuser',
  },

  // Authentication options

  // Lemonldap options
  {
    cliArg: '--llng-ini',
    envVar: 'DM_LLNG_INI',
    defaultValue: '/etc/lemonldap-ng/lemonldap-ng.ini',
  },
];

export default configArgs;
