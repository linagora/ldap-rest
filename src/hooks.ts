/**
 * Types for hooks
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { SearchOptions, SearchResult } from 'ldapts';
import type { Request, Response } from 'express';

import type { ModifyRequest, AttributesList } from './lib/ldapActions';
import type { ChangesToNotify } from './plugins/ldap/onChange';
import * as utils from './lib/utils';

export type MaybePromise<T> = Promise<T> | T;
export type ChainedHook<T> = (arg: T) => MaybePromise<T>;
export type VoidHook<T extends unknown[]> = (...args: T) => MaybePromise<void>;
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type OtherHook = Function;
export { utils };

/**
 * All available hooks
 */

export interface Hooks {
  /**
   * Libraries
   */

  /* LDAP */

  // search
  ldapsearchopts?: ChainedHook<SearchOptions>;
  ldapsearchrequest?: ChainedHook<[string, SearchOptions, Request?]>;
  ldapsearchresult?: ChainedHook<SearchResult>;
  // add
  ldapaddrequest?: ChainedHook<[string, AttributesList, Request?]>;
  ldapadddone?: (args: [string, AttributesList]) => MaybePromise<void>;
  // modify
  ldapmodifyrequest?: ChainedHook<[string, ModifyRequest, number]>;
  ldapmodifydone?: (
    args: [string, ModifyRequest, number]
  ) => MaybePromise<void>;
  // delete
  ldapdeleterequest?: ChainedHook<string | string[]>;
  ldapdeletedone?: (dn: string | string[]) => MaybePromise<void>;
  // rename
  ldaprenamerequest?: ChainedHook<[string, string]>;
  ldaprenamedone?: (args: [string, string]) => MaybePromise<void>;

  /**
   * Plugins
   */

  /** Demo plugin */
  hello?: () => string;

  /** LdapGroups plugin */
  ldapgroupvalidatemembers?: ChainedHook<[string, string[]]>;
  ldapgroupadd?: ChainedHook<[string, AttributesList]>;
  ldapgroupadddone?: (args: [string, AttributesList]) => MaybePromise<void>;

  // the number given as 3rd argument is a uniq operation number
  // It can be used to save state before modify and launch the
  // real hook after change but with previous value
  ldapgroupmodify?: ChainedHook<[string, ModifyRequest, number]>;
  ldapgroupmodifydone?: (
    args: [string, ModifyRequest, number]
  ) => MaybePromise<void>;

  ldapgroupdelete?: ChainedHook<string>;
  ldapgroupdeletedone?: (dn: string) => MaybePromise<void>;
  ldapgroupaddmember?: ChainedHook<[string, string[]]>;
  ldapgroupdeletemember?: ChainedHook<[string, string[]]>;
  // this hook is for low-level ldap listGroups method
  _ldapgrouplist?: ChainedHook<AsyncGenerator<SearchResult>>;

  /** "onLdapChange" */
  onLdapChange?: (dn: string, changes: ChangesToNotify) => MaybePromise<void>;
  onLdapMailChange?: (
    dn: string,
    oldMail: string,
    newMail: string
  ) => MaybePromise<void>;
  onLdapAliasChange?: (
    dn: string,
    mail: string,
    oldAliases: string[],
    newAliases: string[]
  ) => MaybePromise<void>;
  onLdapQuotaChange?: (
    dn: string,
    mail: string,
    oldQuota: number,
    newQuota: number
  ) => MaybePromise<void>;

  /** externalUsersInGroup */
  externaluserentry?: ChainedHook<[string, AttributesList]>;
  externaluseradded?: (dn: string, mail: string) => MaybePromise<void>;

  // External hooks
  [K: string]:
    | ChainedHook<unknown>
    | VoidHook<unknown[]>
    | OtherHook
    | undefined;

  /** Common authentication hooks */
  beforeAuth?: ChainedHook<[Request, Response]>;
  afterAuth?: ChainedHook<[Request, Response]>;

  /** Organization hooks */
  getOrganisationTop?: ChainedHook<
    [Request | undefined, AttributesList | null]
  >;
}
