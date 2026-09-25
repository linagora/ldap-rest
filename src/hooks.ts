/**
 * Types for hooks
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Entry, SearchOptions, SearchResult } from 'ldapts';
import type { Request, Response } from 'express';

import type {
  ModifyRequest,
  AttributesList,
  AttributeValue,
} from './lib/ldapActions';
import type { ChangesToNotify } from './plugins/ldap/onChange';
import type { ChangeContext } from './lib/changeContext';
import * as utils from './lib/utils';

export type MaybePromise<T> = Promise<T> | T;
export type ChainedHook<T> = (arg: T) => MaybePromise<T>;

/**
 * What identifies an OpenID Connect session on both sides of a Back-Channel
 * Logout: the issuer, plus whichever of `sid` and `sub` the provider sends.
 * At least one of the two is present — the specification requires it, and
 * `express-openid-connect` refuses the token otherwise.
 */
export interface OidcSessionClaims {
  iss: string;
  sid?: string;
  sub?: string;
}
export type OidcLogoutToken = OidcSessionClaims;

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
  /**
   * What a given caller is allowed to see of a search that already ran.
   *
   * Distinct from `ldapsearchresult`, and deliberately so: that one fires
   * before the result is cached and is handed no request, so anything it
   * removed for one caller would be served from the cache to the next. This
   * one runs after the cache, on every return path, and carries the request —
   * so a subscriber may drop entries per caller without the answer outliving
   * them. On a paginated search it is called once per chunk, and a chunk may
   * come back with every entry dropped and none left, a page whose entries
   * all belong elsewhere: the search goes on, so a consumer that reads an
   * empty chunk as the end of the results would stop early.
   */
  ldapsearchfilter?: ChainedHook<[SearchResult, Request?, SearchOptions?]>;
  // add
  ldapaddrequest?: ChainedHook<[string, AttributesList, Request?]>;
  // The "done" hooks get, after their arguments, who made the write and
  // through which door: empty for a write no request is behind
  ldapadddone?: (
    args: [string, AttributesList],
    context?: ChangeContext
  ) => MaybePromise<void>;
  // modify
  ldapmodifyrequest?: ChainedHook<[string, ModifyRequest, number, Request?]>;
  ldapmodifydone?: (
    args: [string, ModifyRequest, number],
    context?: ChangeContext
  ) => MaybePromise<void>;
  // delete
  ldapdeleterequest?: ChainedHook<[string | string[], Request?]>;
  ldapdeletedone?: (
    dn: string | string[],
    context?: ChangeContext
  ) => MaybePromise<void>;
  // rename
  ldaprenamerequest?: ChainedHook<[string, string, Request?]>;
  ldaprenamedone?: (
    args: [string, string],
    context?: ChangeContext
  ) => MaybePromise<void>;

  /**
   * Plugins
   */

  /** Demo plugin */
  hello?: () => string;

  /**
   * OpenID Connect session validity
   *
   * `core/auth/openidconnect` knows how to receive a logout token and how to
   * ask whether the session in front of it is still alive; it knows nothing
   * about where that answer is kept. A Back-Channel Logout plugin subscribes
   * to these two and supplies it.
   *
   * `oidcsessionvalid` carries the claims and the verdict so far: a
   * subscriber that has nothing to say passes the pair along unchanged, and
   * one that knows the session is dead answers `false`. Chained, so a refusal
   * already given is never turned back into an acceptance.
   */
  oidcsessionvalid?: ChainedHook<[OidcSessionClaims, boolean]>;

  /** A logout token arrived and verified; subscribers record what it kills. */
  oidclogouttoken?: VoidHook<[OidcLogoutToken]>;

  /**
   * A session was just established; subscribers forget what would kill it.
   *
   * A logout token names a `sid`, a `sub`, or both, and a mark on the `sub`
   * kills every session of that person — including the ones created
   * afterwards, which is not what logging out means. Clearing it here is what
   * keeps an old logout from reaching a session younger than itself.
   *
   * It has a consequence worth knowing: clearing the `sub` mark also revives
   * sessions killed by a "log out everywhere" token that carried no `sid`.
   * The library's own default hook behaves the same way.
   */
  oidclogin?: VoidHook<[OidcSessionClaims]>;

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

  /**
   * "onLdapChange"
   *
   * `onLdapEntryChange` gives the entry as the directory held it before and
   * after an add, a modify, a rename or a delete; the other hooks are derived
   * from it. `before` is null on an add, `after` on a delete, and on a rename
   * their `dn` differ. A write that changed nothing fires none of them.
   */
  onLdapEntryChange?: (
    dn: string,
    before: Entry | null,
    after: Entry | null,
    context: ChangeContext
  ) => MaybePromise<void>;
  onLdapChange?: (dn: string, changes: ChangesToNotify) => MaybePromise<void>;
  onLdapMailChange?: (
    dn: string,
    oldMail: AttributeValue | null,
    newMail: AttributeValue | null
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
  onLdapForwardChange?: (
    dn: string,
    mail: string,
    oldForwards: string[],
    newForwards: string[]
  ) => MaybePromise<void>;
  onLdapDisplayNameChange?: (
    dn: string,
    oldDisplayName: string | null,
    newDisplayName: string | null
  ) => MaybePromise<void>;
  onLdapDriveQuotaChange?: (
    dn: string,
    oldDriveQuota: number | null,
    newDriveQuota: number | null
  ) => MaybePromise<void>;

  /** externalUsersInGroup */
  externaluserentry?: ChainedHook<[string, AttributesList]>;
  externaluseradded?: (dn: string, mail: string) => MaybePromise<void>;

  /**
   * Generic flat resource move hooks
   * Pattern: {hookPrefix}move
   * Examples: ldapusermove, ldappositionmove, etc.
   *
   * move: before moving - can modify target or cancel
   * Note: After move, onLdapChange is triggered automatically by modifyEntry()
   */
  // Note: These are defined dynamically via the index signature below
  // but documented here for reference:
  // - ldapusermove?: ChainedHook<[string, string, Request?]>  // [dn, targetOrgDn, req]

  // External hooks (allows dynamic hook names like ldapusermove, ldapgroupmove, etc.)
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

  /**
   * SCIM plugin hooks (typed dynamically via the index signature above)
   *
   * - scimusercreate:      ChainedHook<[ScimUser, Request?]>     — pre-create, can mutate
   * - scimusercreatedone:  VoidHook<[ScimUser]>                   — post-create
   * - scimuserupdate:      ChainedHook<[string, ScimUser, Request?]>
   * - scimuserupdatedone:  VoidHook<[string, ScimUser]>
   * - scimuserdelete:      ChainedHook<[string, Request?]>
   * - scimuserdeletedone:  VoidHook<[string]>
   * - scimgroupcreate:     ChainedHook<[ScimGroup, Request?]>
   * - scimgroupcreatedone: VoidHook<[ScimGroup]>
   * - scimgroupupdate:     ChainedHook<[string, ScimGroup, Request?]>
   * - scimgroupupdatedone: VoidHook<[string, ScimGroup]>
   * - scimgroupdelete:     ChainedHook<[string, Request?]>
   * - scimgroupdeletedone: VoidHook<[string]>
   * - scimbulkdone:        VoidHook<[BulkResponse]>
   */
}
