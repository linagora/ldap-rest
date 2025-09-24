import { Client, Attribute, Change } from 'ldapts';
import type { ClientOptions, SearchResult, SearchOptions } from 'ldapts';

import { type Config } from '../config/args';
import { type DM } from '../bin';

import { launchHooks, launchHooksChained } from './utils';

// Typescript interface

// Entry
export type AttributeValue = Buffer | Buffer[] | string[] | string;
export type AttributesList = Record<string, AttributeValue>;
export type LdapList = Record<string, AttributesList>;

// search
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
export type { SearchOptions, SearchResult };

// modify
export interface ModifyRequest {
  add?: AttributesList;
  replace?: AttributesList;
  delete?: string[] | AttributesList;
}

// Code

class ldapActions {
  config: Config;
  options: ClientOptions;
  dn: string;
  pwd: string;
  base: string;
  parent: DM;

  constructor(server: DM) {
    this.parent = server;
    this.config = server.config;
    if (!server.config.ldap_url) {
      throw new Error('LDAP URL is not defined');
    }
    if (!server.config.ldap_dn) {
      throw new Error('LDAP DN is not defined');
    }
    if (!server.config.ldap_pwd) {
      throw new Error('LDAP password is not defined');
    }
    if (!server.config.ldap_base) {
      this.base = server.config.ldap_dn.split(',', 2)[1];
      console.warn(`LDAP base is not defined, using "${this.base}"`);
    } else {
      this.base = server.config.ldap_base;
    }
    this.options = {
      url: server.config.ldap_url,
      timeout: 0,
      connectTimeout: 0,
      strictDN: true,
    };
    if (server.config.ldap_url.startsWith('ldaps://')) {
      this.options.tlsOptions = {
        minVersion: 'TLSv1.2',
      };
    }
    this.dn = server.config.ldap_dn;
    this.pwd = server.config.ldap_pwd;
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

  /*
    LDAP search
   */
  async search(
    options: SearchOptions,
    base: string = this.base
  ): Promise<SearchResult | AsyncGenerator<SearchResult>> {
    const client = await this.connect();
    let opts = {
      ...defaultSearchOptions,
      ...options,
    };
    opts = await launchHooksChained(this.parent.hooks.ldapsearchopts, opts);
    let res = opts.paged
      ? client.searchPaginated(base, opts)
      : client.search(base, opts);
    res = (await launchHooksChained(
      this.parent.hooks.ldapsearchresult,
      res
    )) as typeof res;
    return res;
  }

  /*
    LDAP add
   */
  async add(dn: string, entry: AttributesList): Promise<boolean> {
    dn = this.setDn(dn);
    if (
      (!entry.objectClass || entry.objectClass.length === 0) &&
      this.config.user_class
    ) {
      entry.objectClass = this.config.user_class;
    }
    const client = await this.connect();
    // Convert Buffer/Buffer[] values to string/string[]
    const sanitizedEntry: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (Buffer.isBuffer(value)) {
        sanitizedEntry[key] = value.toString();
      } else if (
        Array.isArray(value) &&
        value.length > 0 &&
        Buffer.isBuffer(value[0])
      ) {
        sanitizedEntry[key] = (value as Buffer[]).map(v => v.toString());
      } else {
        sanitizedEntry[key] = value as string | string[];
      }
    }
    [dn, entry] = (await launchHooksChained(this.parent.hooks.ldapaddrequest, [
      dn,
      sanitizedEntry,
    ])) as [string, typeof entry];
    try {
      await client.add(dn, sanitizedEntry);
      void launchHooks(this.parent.hooks.ldapadddone, dn, entry);
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP add error: ${error}`);
    }
  }

  /*
    LDAP modify
   */
  async modify(dn: string, changes: ModifyRequest): Promise<boolean> {
    dn = this.setDn(dn);
    const ldapChanges: Change[] = [];
    const op: number = this.opNumber();
    [dn, changes] = await launchHooksChained(
      this.parent.hooks.ldapmodifyrequest,
      [dn, changes, op]
    );
    if (changes.add) {
      for (const [key, value] of Object.entries(changes.add)) {
        ldapChanges.push(
          new Change({
            operation: 'add',
            modification: new Attribute({
              type: key,
              values: Array.isArray(value) ? value : [value as string],
            }),
          })
        );
      }
    }
    if (changes.replace) {
      for (const [key, value] of Object.entries(changes.replace)) {
        ldapChanges.push(
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: key,
              values: Array.isArray(value) ? value : [value as string],
            }),
          })
        );
      }
    }

    if (changes.delete) {
      if (Array.isArray(changes.delete)) {
        for (const attr of changes.delete) {
          if (attr)
            ldapChanges.push(
              new Change({
                operation: 'delete',
                modification: new Attribute({
                  type: attr,
                  values: [],
                }),
              })
            );
        }
      } else {
        for (const [key, value] of Object.entries(changes.delete)) {
          const change = new Change({
            operation: 'delete',
            modification: value
              ? new Attribute({
                  type: key,
                  values: Array.isArray(value)
                    ? (value as string[])
                    : [value as string],
                })
              : new Attribute({ type: key }),
          });
          ldapChanges.push(change);
        }
      }
    }
    if (ldapChanges.length !== 0) {
      const client = await this.connect();
      try {
        await client.modify(dn, ldapChanges);
        void launchHooks(this.parent.hooks.ldapmodifydone, [dn, changes, op]);
        return true;
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`LDAP modify error: ${error}`);
      }
    } else {
      console.error('No changes to apply');
      void launchHooks(this.parent.hooks.ldapmodifydone, [dn, {}, op]);
      return false;
    }
  }

  async rename(dn: string, newRdn: string): Promise<boolean> {
    dn = this.setDn(dn);
    newRdn = this.setDn(newRdn);
    [dn, newRdn] = await launchHooksChained(
      this.parent.hooks.ldaprenamerequest,
      [dn, newRdn]
    );
    const client = await this.connect();
    try {
      await client.modifyDN(dn, newRdn);
      void launchHooks(this.parent.hooks.ldaprenamedone, [dn, newRdn]);
      return true;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`LDAP rename error: ${error}`);
    }
  }

  /*
    LDAP delete
   */
  async delete(dn: string | string[]): Promise<boolean> {
    if (Array.isArray(dn)) {
      dn = dn.map(d => this.setDn(d));
    } else {
      dn = this.setDn(dn);
    }
    if (!Array.isArray(dn)) dn = [dn];
    dn = (await launchHooksChained(
      this.parent?.hooks.ldapdeleterequest,
      dn
    )) as string | string[];
    const client = await this.connect();
    for (const entry of dn) {
      try {
        await client.del(entry);
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`LDAP delete error: ${error}`);
      }
      void launchHooks(this.parent.hooks.ldapdeletedone, entry);
    }
    return true;
  }

  private setDn(dn: string): string {
    if (!/=/.test(dn)) {
      dn = `uid=${dn},${this.base}`;
    } else if (!/,/.test(dn)) {
      dn += `,${this.base}`;
    }
    return dn;
  }

  opNumber(): number {
    return this.parent.operationSequence++;
  }
}

export default ldapActions;
