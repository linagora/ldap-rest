export interface Config {
  port: number;
  auth?: string;
  llng_ini?: string;
  ldap_url?: string;
  ldap_dn?: string;
  ldap_pwd?: string;
}

const configArgs = [
  {
    cliArg: '--port',
    envVar: 'DM_PORT',
    defaultValue: 8081,
    isInteger: true,
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
];

export default configArgs;
