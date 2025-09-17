import { Client } from 'ldapts';
import { type ClientOptions } from 'ldapts';

import { type Config } from '../config/args';

class ldapActions {
  config: Config;
  options: ClientOptions;
  dn: string;
  pwd: string;

  constructor(config: Config) {
    this.config = config;
    if (!this.config.ldap_url) {
      throw new Error('LDAP URL is not defined');
    }
    if (!this.config.ldap_dn) {
      throw new Error('LDAP DN is not defined');
    }
    if (!this.config.ldap_pwd) {
      throw new Error('LDAP password is not defined');
    }
    this.options = {
      url: this.config.ldap_url,
      timeout: 0,
      connectTimeout: 0,
      strictDN: true,
    };
    if (this.config.ldap_url.startsWith('ldaps://')) {
      this.options.tlsOptions = {
        minVersion: 'TLSv1.2',
      };
    }
    this.dn = this.config.ldap_dn;
    this.pwd = this.config.ldap_pwd;
  }

  /* Connect to LDAP server

   Here we choose to have no persistent LDAP connection
   This is safer because a persistent connection must
   be monitored and reconnected if needed
   and such admin tool won't push a lot of requests
   */
  async connect(): Promise<Client | null> {
    const client: Client = new Client(this.options);
    try {
      await client.bind(this.dn, this.pwd);
      return client;
    } catch (error) {
      console.error('LDAP bind error:', error);
      return null;
    }
  }
}

export default ldapActions;
