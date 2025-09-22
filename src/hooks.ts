import type { SearchOptions, SearchResult } from 'ldapts';

import type { ModifyRequest, AttributesList } from './lib/ldapActions';
import type { ChangesToNotify } from './plugins/onLdapChange';

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
    args: [string, AttributesList]
  ) => [string, AttributesList] | Promise<[string, AttributesList]>;
  ldapadddone?: (args: [string, AttributesList]) => void | Promise<void>;
  // modify
  ldapmodifyrequest?: (
    args: [string, ModifyRequest, number]
  ) =>
    | [string, ModifyRequest, number]
    | Promise<[string, ModifyRequest, number]>;
  ldapmodifydone?: (
    args: [string, ModifyRequest, number]
  ) => void | Promise<void>;
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
  ldapgroupvalidatemembers?: (
    args: [string, string[]]
  ) => [string, string[]] | Promise<[string, string[]]>;
  ldapgroupadd?: (
    args: [string, AttributesList]
  ) => [string, AttributesList] | Promise<[string, AttributesList]>;
  ldapgroupadddone?: (args: [string, AttributesList]) => void | Promise<void>;

  // the number given as 3rd argument is a uniq operation number
  // It can be used to save state before modify and launch the
  // real hook after change but with previous value
  ldapgroupmodify?: (
    args: [string, ModifyRequest, number]
  ) =>
    | [string, ModifyRequest, number]
    | Promise<[string, ModifyRequest, number]>;
  ldapgroupmodifydone?: (
    args: [string, ModifyRequest, number]
  ) => void | Promise<void>;

  ldapgroupdelete?: (dn: string) => string | Promise<string>;
  ldapgroupdeletedone?: (dn: string) => void | Promise<void>;
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

  /* "onLdapChange" */
  onLdapChange?: (dn: string, changes: ChangesToNotify) => void | Promise<void>;
  onLdapMailChange?: (
    dn: string,
    oldMail: string,
    newMail: string
  ) => void | Promise<void>;

  /* TwakeExternalUsersInGroup */
  externaluserentry?: (
    arg: [string, AttributesList]
  ) => [string, AttributesList] | Promise<[string, AttributesList]>;
  externaluseradded?: (dn: string, mail: string) => void | Promise<void>;
}
