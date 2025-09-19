import { Client } from 'ldapts';
import { type ClientOptions, SearchResult, SearchOptions } from 'ldapts';

import { type Config } from '../config/args';
import { type DM } from '../bin';

const defaultSearchOptions: SearchOptions = {
  scope: 'sub',
  filter: '(objectClass=*)',
  attributes: ['*'],
  sizeLimit: 0,
  timeLimit: 10,
  paged: {
    pageSize: 100,
  },
};

class ldapActions {
  config: Config;
  options: ClientOptions;
  dn: string;
  pwd: string;
  base: string;
  parent?: DM;

  constructor(config: Config, server?: DM) {
    this.config = config;
    if (server) this.parent = server;
    if (!this.config.ldap_url) {
      throw new Error('LDAP URL is not defined');
    }
    if (!this.config.ldap_dn) {
      throw new Error('LDAP DN is not defined');
    }
    if (!this.config.ldap_pwd) {
      throw new Error('LDAP password is not defined');
    }
    if (!this.config.ldap_base) {
      this.base = this.config.ldap_dn.split(',', 2)[1];
      console.warn(`LDAP base is not defined, using "${this.base}"`);
    } else {
      this.base = this.config.ldap_base;
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
  async connect(): Promise<Client> {
    const client: Client = new Client(this.options);
    try {
      await client.bind(this.dn, this.pwd);
    } catch (error) {
      console.error('LDAP bind error:', error);
      throw new Error('LDAP bind error');
    }
    if (!client) throw new Error('LDAP connection error');
    return client;
  }

  async search(
    options: SearchOptions,
    base: string = this.base
  ): Promise<SearchResult | AsyncGenerator<SearchResult>> {
    const client = await this.connect();
    let opts = {
      ...defaultSearchOptions,
      ...options,
    };
    if (this.parent?.hooks['ldapsearchopts']) {
      for (const hook of this.parent.hooks['ldapsearchopts']) {
        opts = hook(opts);
      }
    }
    let res = opts.paged ? client.searchPaginated(base, opts) : client.search(base, opts);
    if (this.parent?.hooks['ldapsearchresult']) {
      for (const hook of this.parent.hooks['ldapsearchresult']) {
        res = hook(res);
      }
    }
    return res;
  }
}

export default ldapActions;
