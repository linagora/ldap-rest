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
  LdapList,
} from './lib/ldapActions';
import type { ChangesToNotify } from './plugins/ldap/onChange';
import type { ChangeContext } from './lib/changeContext';
import type { BulkResponse, ScimGroup, ScimUser } from './plugins/scim/types';
import * as utils from './lib/utils';

export type MaybePromise<T> = Promise<T> | T;
export type ChainedHook<T> = (arg: T) => MaybePromise<T>;

/**
 * What identifies an OpenID Connect session on both sides of a Back-Channel
 * Logout: the issuer, plus whichever of `sid` and `sub` the provider sends.
 * At least one of the two is present in a logout token — the specification
 * requires it, and `express-openid-connect` refuses the token otherwise.
 *
 * `session` is the id `core/auth/openidconnect` gave the session at login and
 * keeps in its cookie. `/logout` ends a session by it: a provider that sends
 * no `sid` leaves nothing else naming that one session, and a mark on the
 * `sub` would end every session of that person.
 */
export interface OidcSessionClaims {
  iss: string;
  sid?: string;
  sub?: string;
  session?: string;
}
export type OidcLogoutToken = OidcSessionClaims;

export type VoidHook<T extends unknown[]> = (...args: T) => MaybePromise<void>;
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
    dn: string,
    entry: AttributesList,
    context?: ChangeContext
  ) => MaybePromise<void>;
  /** See docs/plugin-development/hooks.md#ldapaddafter */
  ldapaddafter?: (
    dn: string,
    entry: AttributesList,
    context?: ChangeContext
  ) => MaybePromise<void>;
  // modify
  ldapmodifyrequest?: ChainedHook<[string, ModifyRequest, number, Request?]>;
  ldapmodifydone?: (
    dn: string,
    changes: ModifyRequest,
    op: number,
    context?: ChangeContext
  ) => MaybePromise<void>;
  /**
   * Once a modify is over, whatever became of it, after its `ldapmodifydone`
   * subscribers have returned; with the operation number
   */
  ldapmodifyend?: (op: number) => MaybePromise<void>;
  // delete
  ldapdeleterequest?: ChainedHook<[string | string[], Request?]>;
  ldapdeletedone?: (
    dn: string | string[],
    context?: ChangeContext
  ) => MaybePromise<void>;
  /**
   * Once a delete is over, whatever became of it, after its `ldapdeletedone`
   * subscribers have returned; with the operation number its request and
   * done hooks read from `currentOperation()`
   */
  ldapdeleteend?: (op: number) => MaybePromise<void>;
  // rename
  ldaprenamerequest?: ChainedHook<[string, string, Request?]>;
  ldaprenamedone?: (
    dn: string,
    newDn: string,
    context?: ChangeContext
  ) => MaybePromise<void>;
  /**
   * Once a rename is over, whatever became of it, after its `ldaprenamedone`
   * subscribers have returned; with the operation number its request and
   * done hooks read from `currentOperation()`
   */
  ldaprenameend?: (op: number) => MaybePromise<void>;

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

  /**
   * A logout token arrived and verified, or `/logout` ended a session here;
   * subscribers record what it kills.
   */
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
  ldapgroupadddone?: (dn: string, entry: AttributesList) => MaybePromise<void>;

  // the number given as 3rd argument is a uniq operation number
  // It can be used to save state before modify and launch the
  // real hook after change but with previous value
  ldapgroupmodify?: ChainedHook<[string, ModifyRequest, number]>;
  ldapgroupmodifydone?: (
    dn: string,
    changes: ModifyRequest,
    op: number
  ) => MaybePromise<void>;

  ldapgrouprename?: ChainedHook<[string, string]>;
  ldapgrouprenamedone?: (dn: string, newDn: string) => MaybePromise<void>;
  /** Before `ldapgroupadd`, to judge the group about to be created */
  ldapgroupvalidatenew?: ChainedHook<[string, AttributesList]>;
  /** Before `ldapgroupmodify`, to judge the changes about to be written */
  ldapgroupvalidatechanges?: ChainedHook<[string, ModifyRequest]>;

  ldapgroupdelete?: ChainedHook<string>;
  ldapgroupdeletedone?: (dn: string) => MaybePromise<void>;
  ldapgroupaddmember?: ChainedHook<[string, string[]]>;
  ldapgroupdeletemember?: ChainedHook<[string, string]>;
  // this hook is for low-level ldap listGroups method
  _ldapgrouplist?: ChainedHook<LdapList>;

  /**
   * "onLdapChange"
   *
   * `onLdapEntryChange` gives the entry as the directory held it before and
   * after an add, a modify, a rename or a delete; the other hooks are derived
   * from it. `before` is null on an add, `after` on a delete, and on a rename
   * their `dn` differ. A write that changed nothing fires none of them. A
   * delete fires `onLdapEntryChange`, `onLdapChange` and `onLdapMailChange`
   * only, and the hooks given a `mail` fire only while the entry has one.
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
  /** The external member was created, with its DN and the entry written */
  externaluseradded?: (dn: string, entry: AttributesList) => MaybePromise<void>;

  /**
   * Generic flat resource hooks, one set per `--ldap-flat-schema` entity,
   * `ldapusermove` for one renamed user: `{hookPrefix}` followed by the
   * suffix of the shared hook of the same kind, see {@link FlatHookPrefix}.
   * An entity's `move` hook takes `[dn, targetOrgDn, request?]`, and a move
   * is followed by `onLdapChange`, as a modify is.
   */

  /** Common authentication hooks */
  beforeAuth?: ChainedHook<[Request, Response]>;
  afterAuth?: ChainedHook<[Request, Response]>;

  /** Organization hooks */
  getOrganisationTop?: ChainedHook<[Request | undefined, AttributesList]>;

  /**
   * SCIM plugin hooks
   *
   * The `create` and `update` hooks are chained and can mutate the resource
   * about to be written; the `done` ones are notified once it is written.
   * `scimgroupcreate` gets the group's base beside the request, which is
   * always there: a group is created through the API.
   */
  scimusercreate?: ChainedHook<[ScimUser, Request?]>;
  scimusercreatedone?: VoidHook<[ScimUser]>;
  scimuserupdate?: ChainedHook<[string, ScimUser, Request?]>;
  scimuserupdatedone?: VoidHook<[string, ScimUser]>;
  scimuserdelete?: ChainedHook<[string, Request?]>;
  scimuserdeletedone?: VoidHook<[string]>;
  /** `[group, request, base]` */
  scimgroupcreate?: ChainedHook<[ScimGroup, Request, string]>;
  scimgroupcreatedone?: VoidHook<[ScimGroup]>;
  scimgroupupdate?: ChainedHook<[string, ScimGroup, Request?]>;
  scimgroupupdatedone?: VoidHook<[string, ScimGroup]>;
  scimgroupdelete?: ChainedHook<[string, Request?]>;
  scimgroupdeletedone?: VoidHook<[string]>;
  scimbulkdone?: VoidHook<[BulkResponse]>;

  /**
   * A delete asked of an entry that is already a tombstone. Fired
   * synchronously with the request that asked it: whoever replays deletions
   * records it from there. `[dn, entry, context]`.
   */
  twakedeletionreplay?: (
    dn: string,
    entry: AttributesList,
    context: ChangeContext
  ) => MaybePromise<void>;
}

/**
 * The prefix of a flat entity's hooks, as `abstract/ldapFlat.ts` builds it:
 * `ldap${entity.name}`. They are `{prefix}add`, `{prefix}adddone` and so on,
 * one convention each, as the shared hook of the same suffix declares it,
 * plus `{prefix}move` before an entry is moved. A plugin watching one
 * declares them beside its other hooks.
 */
export type FlatHookPrefix = `ldap${string}`;
