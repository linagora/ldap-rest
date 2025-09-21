import type { SearchOptions, SearchResult } from 'ldapts';

import { ModifyRequest, AttributeValue } from './lib/ldapActions';

export interface Hooks {
  /*
   * Libraries
   */

  /* LDAP */

  // search
  ldapsearchopts?: (
    opts: SearchOptions
  ) => SearchOptions | Promise<SearchOptions>;
  ldapsearchresult?: (
    results: SearchResult
  ) => SearchResult | Promise<SearchResult>;
  // add
  ldapaddrequest?: (
    args: [string, Record<string, AttributeValue>]
  ) =>
    | [string, Record<string, AttributeValue>]
    | Promise<[string, Record<string, AttributeValue>]>;
  ldapadddone?: (
    args: [string, Record<string, AttributeValue>]
  ) => void | Promise<void>;
  // modify
  ldapmodifyrequest?: (
    changes: ModifyRequest
  ) => ModifyRequest | Promise<ModifyRequest>;
  ldapmodifydone?: (args: [string, ModifyRequest]) => void | Promise<void>;
  // delete
  ldapdeleterequest?: (
    dn: string | string[]
  ) => string | string[] | Promise<string | string[]>;
  ldapdeletedone?: (dn: string | string[]) => void | Promise<void>;

  /*
   * Plugins
   */

  /* Demo plugin */
  hello?: () => string;

  /* LdapGroups plugin */
  ldapgroupadd?: (
    args: [string, Record<string, AttributeValue>]
  ) =>
    | [string, Record<string, AttributeValue>]
    | Promise<[string, Record<string, AttributeValue>]>;
  ldapgroupmodify?: (
    changes: ModifyRequest
  ) => ModifyRequest | Promise<ModifyRequest>;
  ldapgroupdelete?: (dn: string) => string | Promise<string>;
  ldapgroupaddmember?: (
    args: [string, string[]]
  ) => [string, string[]] | Promise<[string, string[]]>;
  ldapgroupdeletemember?: (
    args: [string, string[]]
  ) => [string, string[]] | Promise<[string, string[]]>;
  // this hook is for low-level ldap listGroups method
  _ldapgrouplist?: (
    groups: AsyncGenerator<SearchResult>
  ) => [AsyncGenerator<SearchResult> | Promise<AsyncGenerator<SearchResult>>];
}
