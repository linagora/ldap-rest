import { ConfigTemplate } from '../lib/parseConfig';

export interface Config {
  port: number;
  auth?: string;
  ldap_dn?: string;
  llng_ini?: string;
  ldap_pwd?: string;
  ldap_url?: string;
  plugin?: string[];
  plugins?: string;
}

const configArgs: ConfigTemplate = [
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
  {
    cliArg: '--llng-ini',
    envVar: 'DM_LLNG_INI',
    defaultValue: '/etc/lemonldap-ng/lemonldap-ng.ini',
  },
  {
    cliArg: '--ldap-url',
    envVar: 'DM_LDAP_URL',
    defaultValue: 'ldap://localhost',
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
  // This automatically declares a --plugins arg as well
  {
    cliArg: '--plugin',
    envVar: 'DM_PLUGINS',
    defaultValue: [],
    type: 'array',
  },
];

export default configArgs;
