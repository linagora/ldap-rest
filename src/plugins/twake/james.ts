import fetch from 'node-fetch';
import type { Express, Request, Response } from 'express';

import TwakePlugin from '../../abstract/twakePlugin';
import { PROBE_TIMEOUT_MS, type HealthStatus } from '../../lib/health';
import { type Role, asyncHandler } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type {
  AttributesList,
  AttributeValue,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import { ConflictError } from '../../lib/errors';
import { extractLdapCode } from '../../lib/ldapCodes';
import { currentOperation } from '../../lib/operation';
import { Hooks } from '../../hooks';
import type { ChangesToNotify } from '../ldap/onChange';
import { wantJson } from '../../lib/expressFormatedResponses';
import { type Schema, roleAttribute } from '../../config/schema';
import { domainBranches, mailDomains } from '../../lib/mailDomains';
import {
  escapeLdapFilter,
  isDnInBranch,
  isDummyMemberDn,
  normalizeDn,
  parseDn,
} from '../../lib/utils';

/** Under the probe's budget, so that a mute James reads as degraded */
const HEALTHCHECK_TIMEOUT_MS = PROBE_TIMEOUT_MS - 500;

/**
 * What James WebAdmin answers about a user missing from its users
 * repository. Read through LDAP, that repository can lag behind the write
 * that created or renamed the user, so a call about that user is retried on
 * these, see docs/usage/plugins/integrations/james-mail.md#replication-lag
 */
const USER_NOT_SEEN_YET = [400, 404] as const;

/**
 * What James answers while its storage does not: a call about a mail domain
 * is retried on these, as an account is on {@link USER_NOT_SEEN_YET}
 */
const JAMES_UNAVAILABLE = [500, 502, 503, 504] as const;

type Identity = {
  id: string;
  email: string;
  mayDelete?: boolean;
  sortOrder?: number;
  htmlSignature?: string;
  textSignature?: string;
};

/** Signatures an identity carries over, see {@link Identity} */
export type Signatures = Pick<Identity, 'htmlSignature' | 'textSignature'>;

/**
 * Twake Mail's default identity among what `?default=true` answered.
 *
 * Chosen again here rather than trusted: a server ignoring `default` would
 * list the server-set identity too, and updating that one is what brought
 * the duplicate back. `!== false`, not `=== true`: an identity without the
 * field is not taken for the server-set one, else every name change would
 * create another.
 */
const pickDefaultIdentity = (
  body: Identity[] | Identity
): Identity | undefined =>
  (Array.isArray(body) ? body : [body])
    .filter(i => i && i.id && i.mayDelete !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0];

/**
 * OpenAPI schemas specific to the James integration.
 *
 * @openapi-component
 * JamesQuotaUsage:
 *   type: object
 *   description: |
 *     Quota information for a mailbox user as returned by the James
 *     WebAdmin API (`GET /quota/users/{mail}`). Contains separate
 *     counters for message count and storage size.
 *   properties:
 *     count:
 *       type: object
 *       description: Message-count quota.
 *       properties:
 *         used:
 *           type: integer
 *           description: Number of messages currently stored.
 *           example: 142
 *         max:
 *           type: integer
 *           nullable: true
 *           description: |
 *             Maximum number of messages allowed. `null` means unlimited.
 *           example: 10000
 *     size:
 *       type: object
 *       description: Storage-size quota (bytes).
 *       properties:
 *         used:
 *           type: integer
 *           description: Bytes currently used.
 *           example: 524288000
 *         max:
 *           type: integer
 *           nullable: true
 *           description: |
 *             Maximum bytes allowed. `null` means unlimited.
 *           example: 2147483648
 *   example:
 *     count:
 *       used: 142
 *       max: 10000
 *     size:
 *       used: 524288000
 *       max: 2147483648
 */
const members = (entry: AttributesList | null): string[] =>
  valuesOf(entry ?? undefined, 'member') ?? [];

/** Whether two attribute names are the same, options and case aside. */
const sameAttr = (a: string, b: string): boolean =>
  a.split(';')[0].toLowerCase() === b.split(';')[0].toLowerCase();

const listOf = (value: AttributeValue | undefined): string[] =>
  value === undefined || value === null
    ? []
    : (Array.isArray(value) ? value : [value]).map(String);

/**
 * The values of an attribute under every spelling of its name: a subtype
 * such as `member;lang-en` holds values of `member` too. Undefined when no
 * key names it.
 */
const valuesOf = (
  list: AttributesList | undefined,
  name: string
): string[] | undefined => {
  if (!list) return undefined;
  const keys = Object.keys(list).filter(key => sameAttr(key, name));
  return keys.length ? keys.flatMap(key => listOf(list[key])) : undefined;
};

/**
 * The values an attribute holds once a modify is applied to the stored
 * entry, in the order LdapActions sends the changes: adds, replaces, then
 * deletes.
 */
const valuesAfter = (
  current: AttributesList,
  changes: ModifyRequest,
  name: string,
  key: (value: string) => string
): string[] => {
  let values = valuesOf(current, name) ?? [];
  const added = valuesOf(changes.add, name);
  if (added) values = [...values, ...added];
  const replaced = valuesOf(changes.replace, name);
  if (replaced) values = replaced;
  const del = changes.delete;
  if (Array.isArray(del)) {
    if (del.some(attr => sameAttr(attr, name))) values = [];
  } else {
    const gone = valuesOf(del, name);
    if (gone) {
      const keys = new Set(gone.map(key));
      values = keys.size ? values.filter(v => !keys.has(key(v))) : [];
    }
  }
  return values;
};

const memberKey = (dn: string): string => {
  try {
    return normalizeDn(dn);
  } catch {
    return dn.toLowerCase();
  }
};

// James has accounts for users only: the address of a group is a list Twake
// Mail reads from LDAP, or a team mailbox
const GROUP_CLASSES = ['groupofnames', 'groupofuniquenames', 'groupofurls'];
const isGroup = (classes: AttributeValue | undefined): boolean =>
  (Array.isArray(classes) ? classes : classes ? [classes] : []).some(c =>
    GROUP_CLASSES.includes(String(c).toLowerCase())
  );

/** Whether a modify writes an attribute, whichever way */
const touches = (changes: ModifyRequest, name: string): boolean =>
  [changes.add, changes.replace].some(
    list => list && Object.keys(list).some(key => sameAttr(key, name))
  ) ||
  (Array.isArray(changes.delete)
    ? changes.delete.some(key => sameAttr(key, name))
    : Object.keys(changes.delete ?? {}).some(key => sameAttr(key, name)));

/** Compare DNs as the directory does; an unparsable one is equal to none */
const sameDn = (a: string, b: string): boolean => {
  try {
    return normalizeDn(a) === normalizeDn(b);
  } catch {
    return false;
  }
};

export default class James extends TwakePlugin {
  name = 'james';
  roles: Role[] = ['consistency', 'api', 'configurable'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
    ldapGroups: 'core/ldap/groups',
  };

  /** James's own health check, asked by the readiness probe outside the request queue */
  async health(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${this.webadminUrl}/healthcheck`, {
        headers: this.createHeaders(),
        signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      });
      return res.ok ? 'ok' : 'degraded';
    } catch {
      return 'degraded';
    }
  }

  // James-specific configuration attributes
  private quotaAttr: string;
  private aliasAttr: string;
  private mailboxTypeAttr: string;
  private forwardAttr: string;
  private initDelay: number;

  constructor(server: DM) {
    super(
      server,
      'james_webadmin_url',
      'james_webadmin_token',
      'james_concurrency'
    );

    // Initialize James-specific configuration attributes
    this.quotaAttr = this.config.quota_attribute as string;
    this.aliasAttr =
      (this.config.alias_attribute as string) || 'mailAlternateAddress';
    this.mailboxTypeAttr =
      (this.config.james_mailbox_type_attribute as string) ||
      'twakeMailboxType';
    this.forwardAttr =
      (this.config.forward_attribute as string) || 'mailForwardingAddress';
    this.initDelay =
      typeof this.config.james_init_delay === 'number'
        ? this.config.james_init_delay
        : 1000;
    this.retryAttempts =
      typeof this.config.james_retry_attempts === 'number'
        ? Math.max(1, this.config.james_retry_attempts)
        : 5;
    this.retryDelay =
      typeof this.config.james_retry_delay === 'number'
        ? Math.max(0, this.config.james_retry_delay)
        : 1000;
  }

  /**
   * Register API routes
   */
  api(app: Express): void {
    const apiPrefix = this.config.api_prefix || '/api';

    /**
     * @openapi
     * summary: Get user quota usage
     * description: |
     *   Returns the current mailbox quota counters (message count and
     *   storage size) for the given user. Requires the Apache James
     *   integration to be configured (`james_webadmin_url`,
     *   `james_webadmin_token`). The quota data is fetched live from
     *   the James WebAdmin API.
     * tags:
     *   - Apache James Integration
     * responses:
     *   '200':
     *     description: Quota information retrieved successfully.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/JamesQuotaUsage' }
     *         example:
     *           count:
     *             used: 142
     *             max: 10000
     *           size:
     *             used: 524288000
     *             max: 2147483648
     *   '400':
     *     description: User has no mail attribute configured in LDAP.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: User alice has no mail attribute
     *   '404':
     *     description: User not found in LDAP, or quota entry absent in James.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: User alice not found
     *   '502':
     *     description: James WebAdmin API is unreachable or returned an error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: "Failed to retrieve quota from James: Bad Gateway"
     *   '500':
     *     description: Unexpected internal error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    // Get quota usage and limits for a user
    app.get(
      `${apiPrefix}/v1/users/:user/quota-usage`,
      asyncHandler((req: Request, res: Response) => this.getUserQuota(req, res))
    );

    this.logger.info(
      `James API registered at ${apiPrefix}/v1/users/:user/quota-usage`
    );
  }

  /**
   * Get quota information for a user
   */
  private async getUserQuota(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;

    const username = req.params.user as string;

    try {
      // Get user's mail from LDAP (escape username to prevent LDAP injection)
      const escapedUsername = escapeLdapFilter(username);
      // As the server: found across branches, then answered only if the caller can read it (readableBy)
      const userResult = await this.server.ldap.system.search(
        {
          scope: 'sub',
          filter: `(uid=${escapedUsername})`,
          paged: false,
          attributes: [this.mailAttr],
        },
        this.config.ldap_base || ''
      );

      // Found as the server, across branches: a user the caller cannot read
      // gets the answer a user that is not there gets
      let userEntry: SearchResult['searchEntries'][number] | undefined;
      for (const entry of (userResult as SearchResult).searchEntries ?? [])
        if (await this.server.ldap.readableBy(String(entry.dn), req)) {
          userEntry = entry;
          break;
        }
      if (!userEntry) {
        res.status(404).json({ error: `User ${username} not found` });
        return;
      }

      const mail = userEntry[this.mailAttr];
      if (!mail) {
        res
          .status(400)
          .json({ error: `User ${username} has no mail attribute` });
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // Get quota from James WebAdmin API
      const quotaUrl = `${this.webadminUrl}/quota/users/${mailStr}`;
      const quotaRes = await this.requestLimit(() =>
        fetch(quotaUrl, {
          method: 'GET',
          headers: this.createHeaders(),
        })
      );

      if (!quotaRes.ok) {
        if (quotaRes.status === 404) {
          res
            .status(404)
            .json({ error: `Quota not found for user ${username}` });
        } else {
          res.status(502).json({
            error: `Failed to retrieve quota from James: ${quotaRes.statusText}`,
          });
        }
        return;
      }

      const quotaData = await quotaRes.json();
      res.json(quotaData);
    } catch (error) {
      this.logger.error({
        plugin: this.name,
        event: 'getUserQuota',
        username,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Internal server error while retrieving quota',
      });
    }
  }

  hooks: Hooks = {
    ldapaddrequest: async ([dn, entry, req]) => {
      const domain = this.teamMailboxDomain(
        valuesOf(entry, this.mailAttr),
        valuesOf(entry, this.mailboxTypeAttr)
      );
      if (domain)
        await this.assertMembersAt(dn, domain, valuesOf(entry, 'member') ?? []);
      return req !== undefined
        ? [dn, entry, req]
        : ([dn, entry] as [string, AttributesList, Request?]);
    },
    ldapmodifyrequest: async ([dn, changes, op, req]) => {
      await this.guardTeamMailboxChange(dn, changes);
      await this.guardDomainChange(dn, changes);
      return [dn, changes, op, req];
    },
    ldapdeleterequest: async ([dn, req]: [string | string[], Request?]) => {
      // The trash leaves no DN for what it moved instead
      for (const target of Array.isArray(dn) ? dn : [dn])
        if (target) await this.guardDomainRemoval(target, 'delete');
      return [dn, req] as [string | string[], Request?];
    },
    ldaprenamerequest: async ([dn, newDn, req]) => {
      await this.guardDomainMove(dn, newDn);
      return [dn, newDn, req];
    },
    // A rename a request makes is followed from onLdapEntryChange, which a
    // move made outside one, as the trash makes them, does not publish
    ldaprenamedone: async ([dn, newDn]: [string, string]) => {
      if (currentOperation() === undefined) await this.followMove(dn, newDn);
    },
    ldapadddone: ([dn, attributes]: [string, AttributesList]) =>
      this.provisionAccount(dn, attributes),
    onLdapMailChange: async (
      dn: string,
      oldmail: AttributeValue | null,
      newmail: AttributeValue | null
    ) => {
      // Convert to strings
      const oldmailStr = oldmail
        ? Array.isArray(oldmail)
          ? String(oldmail[0])
          : String(oldmail)
        : null;
      const newmailStr = newmail
        ? Array.isArray(newmail)
          ? String(newmail[0])
          : String(newmail)
        : null;

      // A mail gained, at an add or later, is provisioned from
      // ldapadddone or onLdapEntryChange
      if (!oldmailStr) {
        this.logger.debug(
          `Skipping mail rename for ${dn}: oldmail is empty (mail attribute was added, not changed)`
        );
        return;
      }

      // Skip if newmail is empty/null (this is a deletion, not a rename).
      // Without this guard the URL would target `/rename/null` and James could
      // rename the mailbox to a literal "null" address.
      if (!newmailStr) {
        this.logger.debug(
          `Skipping mail rename for ${dn}: newmail is empty (mail attribute was deleted, not changed)`
        );
        return;
      }
      if (await this.isGroupDn(dn)) return;

      // Read before the rename: James leaves the identities under the old
      // address, see docs/usage/plugins/integrations/james-mail.md#mail-address-changes
      const signatures = await this.defaultSignatures(oldmailStr);
      const entry = await this.ldapGetAttributes(dn, [
        this.forwardAttr,
        this.displayNameAttr,
        'cn',
        'givenName',
        'sn',
        this.mailAttr,
      ]);
      await this.dropStaleForwards(
        dn,
        newmailStr,
        this.ownForwards(entry?.[this.forwardAttr])
      );

      // Rename the mailbox
      await this.callWebAdminApi(
        'onLdapMailChange',
        `${this.webadminUrl}/users/${oldmailStr}/rename/${newmailStr}?action=rename&force`,
        'POST',
        dn,
        null,
        { oldmail: oldmailStr, newmail: newmailStr },
        USER_NOT_SEEN_YET
      );

      // Get current aliases from LDAP and recreate them for the new mail
      try {
        // As the server: James is kept in step with the directory, whoever's write changed it
        const aliasesEntry = (await this.server.ldap.system.search(
          { paged: false, scope: 'base', attributes: [this.aliasAttr] },
          dn
        )) as SearchResult;

        if (
          aliasesEntry.searchEntries &&
          aliasesEntry.searchEntries.length > 0
        ) {
          const aliases = this.getAliases(
            aliasesEntry.searchEntries[0][this.aliasAttr]
          );

          // Only process if user has aliases
          if (aliases.length > 0) {
            // Delete old aliases and create new ones in parallel. The
            // DELETE needs no retry: James's rename does not move aliases,
            // and the route answers 204 whether the mapping exists or not
            await Promise.all([
              ...aliases.map(alias =>
                this.callWebAdminApi(
                  'onLdapMailChange-delete',
                  `${this.webadminUrl}/address/aliases/${oldmailStr}/sources/${alias}`,
                  'DELETE',
                  dn,
                  null,
                  { oldmail: oldmailStr, alias }
                )
              ),
              ...aliases.map(alias =>
                this.callWebAdminApi(
                  'onLdapMailChange-create',
                  `${this.webadminUrl}/address/aliases/${newmailStr}/sources/${alias}`,
                  'PUT',
                  dn,
                  null,
                  { newmail: newmailStr, alias },
                  USER_NOT_SEEN_YET
                )
              ),
            ]);
          }
        }
      } catch (err) {
        // Silently ignore if user has no aliases attribute
        this.logger.debug('Could not fetch aliases for mail change:', err);
      }

      const displayName = entry && this.getDisplayNameFromAttributes(entry);
      if (displayName)
        await this.updateJamesIdentity(dn, newmailStr, displayName, signatures);
    },
    onLdapAliasChange: async (
      dn: string,
      mail: string,
      oldAliases: string[],
      newAliases: string[]
    ) => {
      if (await this.isGroupDn(dn)) return;
      // Normalize aliases
      const oldNormalized = oldAliases.map(a => this.normalizeAlias(a));
      const newNormalized = newAliases.map(a => this.normalizeAlias(a));

      // Find aliases to delete (in old but not in new)
      const toDelete = oldNormalized.filter(a => !newNormalized.includes(a));

      // Find aliases to add (in new but not in old)
      const toAdd = newNormalized.filter(a => !oldNormalized.includes(a));

      // Delete and add aliases in parallel
      await Promise.all([
        ...toDelete.map(alias =>
          this.callWebAdminApi(
            'onLdapAliasChange-delete',
            `${this.webadminUrl}/address/aliases/${mail}/sources/${alias}`,
            'DELETE',
            dn,
            null,
            { mail, alias, action: 'delete' }
          )
        ),
        ...toAdd.map(async alias => {
          await this.dropStaleForwards(dn, alias, []);
          await this.callWebAdminApi(
            'onLdapAliasChange-add',
            `${this.webadminUrl}/address/aliases/${mail}/sources/${alias}`,
            'PUT',
            dn,
            null,
            { mail, alias, action: 'add' },
            USER_NOT_SEEN_YET
          );
        }),
      ]);
    },
    onLdapQuotaChange: async (
      dn: string,
      mail: string,
      oldQuota: number,
      newQuota: number
    ) => {
      if (await this.isGroupDn(dn)) return;
      // James reads a user quota of 0 as a 0 byte mailbox: without one, the
      // user falls back on the domain or global quota
      const set = newQuota > 0;
      return this.callWebAdminApi(
        'onLdapQuotaChange',
        `${this.webadminUrl}/quota/users/${mail}/size`,
        set ? 'PUT' : 'DELETE',
        dn,
        set ? newQuota.toString() : null,
        { oldQuota, newQuota },
        USER_NOT_SEEN_YET
      );
    },
    onLdapForwardChange: async (
      dn: string,
      mail: string,
      oldForwards: string[],
      newForwards: string[]
    ) => {
      // Users set their forwards in Twake Mail, see
      // docs/usage/plugins/integrations/james-mail.md#forwards
      if (!this.config.james_sync_forwards) return;
      if (await this.isGroupDn(dn)) return;
      const domain = this.extractMailDomain(mail);
      if (!domain) {
        this.logger.error(
          `Cannot extract domain from mail ${mail} for forward management`
        );
        return;
      }

      // Find forwards to delete (in old but not in new)
      const toDelete = oldForwards.filter(f => !newForwards.includes(f));

      // Find forwards to add (in new but not in old)
      const toAdd = newForwards.filter(f => !oldForwards.includes(f));

      // Delete and add forwards in parallel
      await Promise.all([
        ...toDelete.map(forward =>
          this.callWebAdminApi(
            'onLdapForwardChange-delete',
            `${this.webadminUrl}/address/forwards/${mail}/targets/${forward}`,
            'DELETE',
            dn,
            null,
            { mail, forward, domain, action: 'delete' }
          )
        ),
        ...toAdd.map(forward =>
          this.callWebAdminApi(
            'onLdapForwardChange-add',
            `${this.webadminUrl}/address/forwards/${mail}/targets/${forward}`,
            'PUT',
            dn,
            null,
            { mail, forward, domain, action: 'add' },
            USER_NOT_SEEN_YET
          )
        ),
      ]);
    },

    onLdapChange: async (dn: string, changes: ChangesToNotify) => {
      if (
        this.config.delegation_attribute &&
        changes[this.config.delegation_attribute] &&
        !(await this.isGroupDn(dn))
      ) {
        await this._handleDelegationChange(dn, changes);
      }
    },

    onLdapDisplayNameChange: async (
      dn: string
      // oldDisplayName: string | null,
      // newDisplayName: string | null
    ) => {
      const attrs = [
        this.mailAttr,
        this.displayNameAttr,
        'cn',
        'givenName',
        'sn',
        'objectClass',
      ];

      const entry = await this.ldapGetAttributes(dn, attrs);
      if (!entry) {
        this.logger.warn(
          `Cannot update James identity: entry not found for ${dn}`
        );
        return;
      }
      if (isGroup(entry.objectClass)) return;

      const mail = this.attributeToString(entry[this.mailAttr]);

      if (!mail) {
        this.logger.warn(
          `Cannot update James identity: no mail found for ${dn}`
        );
        return;
      }

      const displayName = this.getDisplayNameFromAttributes(entry);
      if (!displayName) {
        this.logger.warn(
          `Cannot update James identity: no display name found for ${dn}`
        );
        return;
      }

      // Update James identity via JMAP
      return this.updateJamesIdentity(dn, mail, displayName);
    },

    // Only team mailboxes are synchronized: Twake Mail reads mailing lists
    // from LDAP, see docs/usage/plugins/integrations/james-mailboxes.md#mailing-lists
    onLdapEntryChange: async (dn, before, after) => {
      // ldapadddone provisions an entry added with its mail
      if (before && after && !before[this.mailAttr] && after[this.mailAttr])
        await this.provisionAccount(dn, after as AttributesList);
      await this.followTeamMailbox(
        before as AttributesList | null,
        after as AttributesList | null
      );
      // Here only, not from ldapadddone too: this fires once for an add, a
      // modify, a rename and a delete alike
      await this.followDomains(
        before as AttributesList | null,
        after as AttributesList | null
      );
    },
  };

  /**
   * The attribute naming the mail domain of the entry at a DN, when it lies
   * in a domain branch: at any depth, as a deployment may nest its domains
   * (`dc=customs,dc=gov,dc=mn,ou=domains,…`) under nodes naming none. Those
   * are left alone for carrying no domain, not for where they stand. The
   * deepest branch wins.
   */
  private domainAttribute(dn: string): string | undefined {
    let found: string | undefined;
    let depth = -1;
    for (const { base, attribute } of domainBranches(this.server)) {
      try {
        if (sameDn(dn, base) || !isDnInBranch(dn, base)) continue;
        const d = parseDn(base).length;
        if (d > depth) [found, depth] = [attribute, d];
      } catch {
        // An unparsable DN lies in no branch
      }
    }
    return found;
  }

  /** The mail domains an entry declares, none outside the domain branches */
  private domainsOf(entry: AttributesList | null): string[] {
    const attribute = entry?.dn && this.domainAttribute(String(entry.dn));
    return attribute ? mailDomains(valuesOf(entry, attribute)) : [];
  }

  /**
   * The trash turns a delete into a move no request hook sees, and whether
   * the delete guard below runs before it depends on the order the plugins
   * were loaded in: say so when the trash watches the domains.
   */
  afterLoad(): void {
    if (!this.server.loadedPlugins['trash']) return;
    const watched = String(this.config.trash_watched_bases ?? '')
      .split(';')
      .map(base => base.trim())
      .filter(Boolean);
    for (const { base } of domainBranches(this.server)) {
      // Without a list, the trash watches every branch
      const by = watched.length
        ? watched.find(dn => {
            try {
              return isDnInBranch(base, dn) || isDnInBranch(dn, base);
            } catch {
              return false;
            }
          })
        : 'every branch';
      if (by)
        this.logger.warn(
          `James: the trash watches the mail domains of ${base} ` +
            `(--trash-watched-bases: ${by}): a domain deleted there may skip ` +
            `the check that it is still in use; leave the domain branch out ` +
            `of the trash, see ` +
            `docs/usage/plugins/integrations/james-mail.md#trash`
        );
    }
  }

  /**
   * Bring James from the domains an entry declared to those it declares,
   * see docs/usage/plugins/integrations/james-mail.md#mail-domains.
   * `unguarded`: no request hook judged the write, so a domain addresses are
   * still at is kept rather than removed.
   */
  private async followDomains(
    before: AttributesList | null,
    after: AttributesList | null,
    unguarded = false
  ): Promise<void> {
    const was = this.domainsOf(before);
    const is = this.domainsOf(after);
    if (!was.length && !is.length) return;
    const dn = String((after ?? before)!.dn);
    const call = (domain: string, method: 'PUT' | 'DELETE'): Promise<void> =>
      this.callWebAdminApi(
        method === 'PUT' ? 'domain:create' : 'domain:delete',
        `${this.webadminUrl}/domains/${domain}`,
        method,
        dn,
        null,
        { domain },
        JAMES_UNAVAILABLE
      );
    await Promise.all([
      ...is
        .filter(domain => !was.includes(domain))
        .map(domain => this.inDomainOrder(domain, () => call(domain, 'PUT'))),
      ...was
        .filter(domain => !is.includes(domain))
        .map(domain =>
          this.inDomainOrder(domain, async () => {
            if (await this.domainDeclaredElsewhere(domain, dn)) return;
            const user = unguarded ? await this.addressAt(domain) : null;
            if (user) {
              this.logger.error({
                plugin: this.name,
                event: 'domain:delete',
                dn,
                domain,
                result: 'skipped',
                error: `${user} still has an address at ${domain}: the domain is kept in James`,
              });
              return;
            }
            await call(domain, 'DELETE');
          })
        ),
    ]);
  }

  /**
   * Follow a move made outside a request, as the trash makes them:
   * `onLdapEntryChange` is not published for it.
   */
  private async followMove(dn: string, newDn: string): Promise<void> {
    const attributes = [this.domainAttribute(dn), this.domainAttribute(newDn)]
      .filter((name): name is string => Boolean(name))
      .filter((name, i, all) => all.findIndex(n => sameAttr(n, name)) === i);
    if (!attributes.length) return;
    const entry = await this.ldapGetAttributes(newDn, attributes);
    if (!entry) return;
    await this.followDomains({ ...entry, dn }, { ...entry, dn: newDn }, true);
  }

  /**
   * Run the calls about one domain in the order of the writes: an entry
   * added then deleted close together would otherwise race to James, and
   * the creation could land last.
   */
  private async inDomainOrder(
    domain: string,
    step: () => Promise<void>
  ): Promise<void> {
    const previous = this.domainQueue.get(domain) ?? Promise.resolve();
    // A failed step does not hold back the next one
    const current = previous.then(step, step);
    this.domainQueue.set(domain, current);
    try {
      await current;
    } finally {
      if (this.domainQueue.get(domain) === current)
        this.domainQueue.delete(domain);
    }
  }

  private domainQueue: Map<string, Promise<void>> = new Map();

  /**
   * The first entry under `base` that a filter matches and `test` accepts,
   * walked page by page and no further than that entry: a single search
   * fails once the answer outgrows the server's size limit. None when
   * `base` does not exist.
   */
  private async firstEntry(
    base: string,
    filter: string,
    attributes: string[],
    test: (entry: AttributesList) => boolean
  ): Promise<AttributesList | null> {
    try {
      // As the server: James is kept in step with the directory, whoever's write changed it
      const pages = (await this.server.ldap.system.search(
        { paged: { pageSize: 500 }, scope: 'sub', filter, attributes },
        base
      )) as AsyncGenerator<SearchResult>;
      for await (const page of pages)
        for (const entry of page.searchEntries || [])
          if (test(entry as AttributesList)) return entry as AttributesList;
      return null;
    } catch (err) {
      if (extractLdapCode(err) === 32) return null;
      throw err;
    }
  }

  /**
   * Whether an entry other than `dn` declares the domain: James keeps it
   * then. An answer the directory does not give counts as yes, as removing a
   * domain still in use is the worse mistake.
   */
  private async domainDeclaredElsewhere(
    domain: string,
    dn: string
  ): Promise<boolean> {
    try {
      for (const { base, attribute } of domainBranches(this.server)) {
        const found = await this.firstEntry(
          base,
          `(${attribute}=${escapeLdapFilter(domain)})`,
          ['1.1'],
          entry => {
            const at = String(entry.dn);
            const own = this.domainAttribute(at);
            return !sameDn(at, dn) && !!own && sameAttr(own, attribute);
          }
        );
        if (found) return true;
      }
      return false;
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'domain:delete',
        dn,
        domain,
        result: 'skipped',
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /**
   * Refuse to delete, or move out of the domain branches, an entry declaring
   * a mail domain James still needs, see
   * docs/usage/plugins/integrations/james-mail.md#mail-domains. The error
   * names neither the organization nor the address, which the caller may not
   * be allowed to read; the log does.
   *
   * @throws ConflictError
   */
  private async guardDomainRemoval(
    dn: string,
    action: 'delete' | 'move'
  ): Promise<void> {
    const attribute = this.domainAttribute(dn);
    if (!attribute) return;
    const entry = await this.ldapGetAttributes(dn, [attribute]);
    const domains = mailDomains(valuesOf(entry ?? undefined, attribute));
    if (!domains.length) return;
    const holder = await this.domainLinkHolder(dn, String(entry!.dn ?? dn));
    if (holder) {
      this.logger.warn(
        `${action} of ${dn} refused: organization ${holder} links it`
      );
      throw new ConflictError(
        `Cannot ${action} ${dn}: an organization still links mail domain ${domains.join(', ')}`
      );
    }
    for (const domain of domains)
      await this.assertNoAddressAt(dn, domain, `Cannot ${action} ${dn}`);
  }

  /**
   * Refuse a rename or a move that takes domains from an entry while
   * addresses are at them: out of every domain branch, as a delete; into
   * another one, for each domain the entry no longer declares there.
   *
   * @throws ConflictError
   */
  private async guardDomainMove(dn: string, newDn: string): Promise<void> {
    const from = this.domainAttribute(dn);
    if (!from) return;
    const to = this.domainAttribute(newDn);
    if (!to) return this.guardDomainRemoval(dn, 'move');
    const entry =
      (await this.ldapGetAttributes(
        dn,
        sameAttr(from, to) ? [from] : [from, to]
      )) ?? undefined;
    const kept = mailDomains(valuesOf(entry, to));
    for (const domain of mailDomains(valuesOf(entry, from)))
      if (!kept.includes(domain))
        await this.assertNoAddressAt(dn, domain, `Cannot move ${dn}`);
  }

  /**
   * Refuse a modify dropping a domain from an entry while addresses are at
   * it. The organizations linking the entry are no reason to refuse: they
   * follow the entry, whatever it names.
   *
   * @throws ConflictError
   */
  private async guardDomainChange(
    dn: string,
    changes: ModifyRequest
  ): Promise<void> {
    const attribute = this.domainAttribute(dn);
    if (!attribute || !touches(changes, attribute)) return;
    const current = await this.ldapGetAttributes(dn, [attribute]);
    if (!current) return;
    const kept = mailDomains(
      valuesAfter(current, changes, attribute, v => v.toLowerCase())
    );
    for (const domain of mailDomains(valuesOf(current, attribute)))
      if (!kept.includes(domain))
        await this.assertNoAddressAt(
          dn,
          domain,
          `Cannot remove mail domain ${domain} from ${dn}`
        );
  }

  /**
   * The attributes linking an organization to its mail domains: those the
   * loaded schemas give the `domainLink` role, then
   * `--enterprise-domain-link-attribute`. None, and no link is checked,
   * without either.
   */
  private domainLinkAttributes(): string[] {
    const organizations = this.server.loadedPlugins['ldapOrganizations'] as
      | { schema?: Schema }
      | undefined;
    const flat = this.server.loadedPlugins['ldapFlatGeneric'] as
      | { instances?: { schema?: Schema }[] }
      | undefined;
    const names = [
      organizations?.schema,
      ...(flat?.instances || []).map(instance => instance.schema),
    ].map(schema => roleAttribute(schema, 'domainLink'));
    names.push(this.config.enterprise_domain_link_attribute);
    const out: string[] = [];
    for (const name of names)
      if (name && !out.some(n => sameAttr(n, name))) out.push(name);
    return out;
  }

  /**
   * The DN of an entry linking the domain entry at `dn` as one of its mail
   * domains, if one does. A link names the entry by its whole DN, compared
   * as the directory does: linking `dc=gov,dc=mn,…` is no link to
   * `dc=customs,dc=gov,dc=mn,…`. The filter asks for the spelling the
   * caller gave, the directory's and the normalized one, for a link
   * attribute that would not compare as a DN.
   */
  private async domainLinkHolder(
    dn: string,
    stored: string
  ): Promise<string | null> {
    const attributes = this.domainLinkAttributes();
    if (!attributes.length) return null;
    const spellings = [...new Set([dn, stored, normalizeDn(dn)])];
    const filter = `(|${attributes
      .flatMap(attr =>
        spellings.map(value => `(${attr}=${escapeLdapFilter(value)})`)
      )
      .join('')})`;
    const holder = await this.firstEntry(
      this.config.ldap_base || '',
      filter,
      attributes,
      entry =>
        attributes.some(attr =>
          (valuesOf(entry, attr) ?? []).some(value => sameDn(value, dn))
        )
    );
    return holder ? String(holder.dn) : null;
  }

  /**
   * The DN of an entry holding an address, or an alias, at a domain.
   *
   * Every entry with one is read and its domains compared here: a substring
   * filter (`*@domain`) finds nothing on an attribute the directory gives no
   * substring rule, as some schemas declare `mailAlternateAddress`.
   */
  private async addressAt(domain: string): Promise<string | null> {
    const attributes = [this.mailAttr, this.aliasAttr];
    const atDomain = (value: string): boolean =>
      this.extractMailDomain(
        this.normalizeAlias(value.trim())
      )?.toLowerCase() === domain;
    const entry = await this.firstEntry(
      this.config.ldap_base || '',
      `(|${attributes.map(attr => `(${attr}=*)`).join('')})`,
      attributes,
      found =>
        attributes.some(attr => (valuesOf(found, attr) ?? []).some(atDomain))
    );
    return entry ? String(entry.dn) : null;
  }

  /**
   * Throw when an entry holds an address, or an alias, at a domain James
   * is about to drop — unless another entry still declares it.
   *
   * @throws ConflictError, its message starting with `refusal`
   */
  private async assertNoAddressAt(
    dn: string,
    domain: string,
    refusal: string
  ): Promise<void> {
    if (await this.domainDeclaredElsewhere(domain, dn)) return;
    const user = await this.addressAt(domain);
    if (!user) return;
    this.logger.warn(`${refusal}: ${user} still has an address at ${domain}`);
    throw new ConflictError(
      `${refusal}: addresses at ${domain} still exist, and James would refuse their mail`
    );
  }

  /**
   * The address of the team mailbox an entry stands for, and why it is
   * refused, if it is: it lies in a mailing list branch, or TMail cannot
   * name a team mailbox after its address.
   */
  private teamMailboxOf(
    entry: AttributesList | null
  ): { mail: string; refused: string | null } | null {
    if (!entry || this.getMailboxType(entry) !== 'teamMailbox') return null;
    const mail = this.attributeToString(entry[this.mailAttr]);
    if (!mail) return null;
    const dn = String(entry.dn);
    const branches = this.config.james_mailing_list_branch || [];
    if (branches.some(branch => dn === branch || dn.endsWith(',' + branch)))
      return {
        mail,
        refused: `Team mailbox cannot be in mailing list branches: ${branches.join(', ')}`,
      };
    // TMail names a team mailbox by the local part, and refuses any other
    // character in it
    const at = mail.lastIndexOf('@');
    if (
      !/^[#a-zA-Z0-9_-]{1,255}$/.test(mail.slice(0, at)) ||
      !this.extractMailDomain(mail)
    )
      return {
        mail,
        refused:
          'A team mailbox address is a name of letters, digits, #, - and _ at a domain',
      };
    return { mail, refused: null };
  }

  /**
   * Give James what an account holds: quota, aliases and identity, after
   * dropping the forwards left on its addresses. Runs when an entry is
   * added with a mail, or gains one.
   */
  private async provisionAccount(
    dn: string,
    attributes: AttributesList
  ): Promise<void> {
    const mail = attributes[this.mailAttr];
    const quota = attributes[this.quotaAttr];
    const aliases = attributes[this.aliasAttr];

    if (!mail || isGroup(attributes.objectClass)) return;

    const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

    // Wait for James to create the user (configurable delay)
    if (this.initDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.initDelay));
    }

    // Initialize quota if present
    if (quota) {
      const quotaNum = Array.isArray(quota) ? Number(quota[0]) : Number(quota);
      if (!isNaN(quotaNum) && quotaNum > 0) {
        await this.callWebAdminApi(
          'ldapadddone:quota',
          `${this.webadminUrl}/quota/users/${mailStr}/size`,
          'PUT',
          dn,
          quotaNum.toString(),
          { mail: mailStr, quota: quotaNum },
          USER_NOT_SEEN_YET
        );
      }
    }

    const aliasList = this.getAliases(aliases);
    await Promise.all([
      this.dropStaleForwards(
        dn,
        mailStr,
        this.ownForwards(attributes[this.forwardAttr])
      ),
      ...aliasList.map(alias => this.dropStaleForwards(dn, alias, [])),
    ]);

    // Create aliases if present (parallelize API calls)
    if (aliasList.length > 0) {
      await Promise.all(
        aliasList.map(alias =>
          this.callWebAdminApi(
            'ldapadddone:alias',
            `${this.webadminUrl}/address/aliases/${mailStr}/sources/${alias}`,
            'PUT',
            dn,
            null,
            { mail: mailStr, alias },
            USER_NOT_SEEN_YET
          )
        )
      );
    }

    // Initialize James identity
    const displayName = this.getDisplayNameFromAttributes(attributes);
    if (displayName) {
      await this.updateJamesIdentity(dn, mailStr, displayName);
    }
  }

  /**
   * Bring James from the team mailbox an entry was to the one it is. A
   * mailbox the entry no longer stands for is kept, emptied of its members.
   */
  private async followTeamMailbox(
    before: AttributesList | null,
    after: AttributesList | null
  ): Promise<void> {
    const was = this.teamMailboxOf(before);
    const is = this.teamMailboxOf(after);
    if (!was && !is) return;
    const dn = String((after ?? before)!.dn);
    // Once, when the entry comes to be refused, not at each of its changes
    if (is?.refused && is.refused !== was?.refused)
      this.logger.error({
        plugin: this.name,
        event: 'teamMailbox',
        dn,
        mail: is.mail,
        error: is.refused,
      });
    const old = was && !was.refused ? was.mail : null;
    const mail = is && !is.refused ? is.mail : null;
    if (!old && !mail) return;

    // One group at a time: two writes close together would otherwise race
    // to James, a member removed by the second added back by the first
    const key = memberKey(dn);
    const previous = this.teamMailboxQueue.get(key) ?? Promise.resolve();
    const follow = async (): Promise<void> => {
      if (old && mail && old.toLowerCase() === mail.toLowerCase()) {
        const gone = new Map(members(before).map(m => [memberKey(m), m]));
        const added: string[] = [];
        for (const member of members(after))
          if (!gone.delete(memberKey(member))) added.push(member);
        await Promise.all([
          this.teamMailboxMembers(dn, mail, 'PUT', added),
          this.teamMailboxMembers(dn, mail, 'DELETE', [...gone.values()]),
        ]);
        return;
      }
      if (old)
        await this.teamMailboxMembers(dn, old, 'DELETE', members(before));
      if (mail) await this.createTeamMailbox(dn, after!, mail);
    };
    // A failed step does not hold back the next one
    const current = previous.then(follow, follow);
    this.teamMailboxQueue.set(key, current);
    try {
      await current;
    } finally {
      if (this.teamMailboxQueue.get(key) === current)
        this.teamMailboxQueue.delete(key);
    }
  }

  private teamMailboxQueue: Map<string, Promise<void>> = new Map();

  /**
   * Whether a team mailbox may hold members of another mail domain:
   * `--james-team-mailbox-any-domain`, off by default. A client reads it to
   * offer only the members the server accepts.
   */
  getConfigApiData(): Record<string, unknown> {
    return {
      teamMailboxAnyDomain: Boolean(this.config.james_team_mailbox_any_domain),
    };
  }

  /**
   * The mail domain of a team mailbox, lower-cased, from its address and
   * mailbox type; null for any other entry.
   */
  private teamMailboxDomain(
    mail: AttributeValue | undefined,
    type: AttributeValue | undefined
  ): string | null {
    if (
      this.config.james_team_mailbox_any_domain ||
      this.getMailboxType({
        [this.mailboxTypeAttr]: type,
      } as AttributesList) !== 'teamMailbox'
    )
      return null;
    const address = this.attributeToString(mail);
    return address
      ? this.extractMailDomain(address)?.toLowerCase() || null
      : null;
  }

  /**
   * Refuse a change that leaves a team mailbox with a member of another
   * mail domain: a member added, or the mailbox moved to another domain —
   * by its address or by becoming a team mailbox — with the members it
   * holds.
   *
   * Twake Mail does not check it: its WebAdmin adds any address to a team
   * mailbox, and this plugin pushes every member's. Members without an
   * address are not pushed, and are left alone.
   */
  private async guardTeamMailboxChange(
    dn: string,
    changes: ModifyRequest
  ): Promise<void> {
    if (this.config.james_team_mailbox_any_domain) return;
    const watched = [this.mailAttr, this.mailboxTypeAttr, 'member'];
    const touched = [changes.add, changes.replace].some(
      list =>
        list &&
        Object.keys(list).some(name => watched.some(w => sameAttr(name, w)))
    );
    if (!touched) return;
    const current = await this.ldapGetAttributes(dn, watched);
    if (!current) return;
    const after = (name: string, key = (v: string) => v.toLowerCase()) =>
      valuesAfter(current, changes, name, key);
    const domain = this.teamMailboxDomain(
      after(this.mailAttr),
      after(this.mailboxTypeAttr)
    );
    if (!domain) return;
    const held = new Set((valuesOf(current, 'member') ?? []).map(memberKey));
    const kept = after('member', memberKey);
    const gained = kept.filter(m => !held.has(memberKey(m)));
    // The same mailbox: only the members it gains are checked. Elsewhere,
    // those it keeps go along.
    const moved =
      domain !==
      this.teamMailboxDomain(
        valuesOf(current, this.mailAttr),
        valuesOf(current, this.mailboxTypeAttr)
      );
    await this.assertMembersAt(
      dn,
      domain,
      gained,
      moved ? kept.filter(m => held.has(memberKey(m))) : []
    );
  }

  /**
   * Throw when a member holds an address at another domain than the team
   * mailbox's.
   *
   * Only the addresses of the members the write brings are named: the caller
   * may not be allowed to read those the mailbox already holds.
   *
   * @throws ConflictError
   */
  private async assertMembersAt(
    dn: string,
    domain: string,
    brought: string[],
    held: string[] = []
  ): Promise<void> {
    const foreign = async (memberDns: string[]): Promise<string[]> =>
      (await this.getMemberEmails(memberDns)).filter(
        mail => this.extractMailDomain(mail)?.toLowerCase() !== domain
      );
    const [named, unnamed] = await Promise.all([
      foreign(brought),
      foreign(held),
    ]);
    if (named.length === 0 && unnamed.length === 0) return;
    const listed = named.length
      ? `${named.slice(0, 5).join(', ')}${named.length > 5 ? ', …' : ''} ` +
        `${named.length > 1 ? 'are' : 'is'} not`
      : '';
    const others = unnamed.length ? 'some of the members it holds are not' : '';
    throw new ConflictError(
      `The members of team mailbox ${dn} must have an address at ${domain}: ` +
        [listed, others].filter(Boolean).join(', and ')
    );
  }

  /**
   * The WebAdmin path of the team mailbox at an address
   * {@link teamMailboxOf} accepted: TMail names it by the local part, under
   * its domain. Lower-cased, so that a change of case only, which keeps the
   * mailbox, keeps its path.
   */
  private teamMailboxUrl(mail: string): string {
    const lower = mail.toLowerCase();
    const at = lower.lastIndexOf('@');
    return `${this.webadminUrl}/domains/${lower.slice(at + 1)}/team-mailboxes/${encodeURIComponent(lower.slice(0, at))}`;
  }

  private async teamMailboxMembers(
    dn: string,
    mail: string,
    method: 'PUT' | 'DELETE',
    memberDns: string[]
  ): Promise<void> {
    if (!memberDns.length) return;
    const url = this.teamMailboxUrl(mail);
    const memberMails = await this.getMemberEmails(memberDns);
    await Promise.all(
      memberMails.map(memberMail =>
        this.callWebAdminApi(
          `teamMailbox:${method === 'PUT' ? 'addMember' : 'removeMember'}`,
          `${url}/members/${memberMail}`,
          method,
          dn,
          null,
          { teamMailbox: mail, memberMail }
        )
      )
    );
  }

  /**
   * Extract display name from LDAP attributes
   * Fallback logic: displayName → cn → givenName+sn → mail
   */
  private getDisplayNameFromAttributes(
    attributes: import('../../lib/ldapActions').AttributesList
  ): string | null {
    // 1. Try displayName first
    const displayName = this.attributeToString(
      attributes[this.displayNameAttr]
    );
    if (displayName) return displayName;

    // 2. Try cn
    const cn = this.attributeToString(attributes.cn);
    if (cn) return cn;

    // 3. Try givenName + sn
    const givenName = this.attributeToString(attributes.givenName);
    const sn = this.attributeToString(attributes.sn);
    if (givenName || sn) {
      const parts = [];
      if (givenName) parts.push(givenName);
      if (sn) parts.push(sn);
      return parts.join(' ');
    }

    // 4. Fallback to mail
    const mail = this.attributeToString(attributes[this.mailAttr]);
    if (mail) return mail;

    return null;
  }

  private async isGroupDn(dn: string): Promise<boolean> {
    const entry = await this.ldapGetAttributes(dn, ['objectClass']);
    return isGroup(entry?.objectClass);
  }

  async getMailFromDN(dn: string): Promise<string | null> {
    const entry = await this.ldapGetAttributes(dn, [this.mailAttr]);
    return entry ? this.attributeToString(entry[this.mailAttr]) : null;
  }

  async getDisplayNameFromDN(dn: string): Promise<string | null> {
    const attrs = [
      this.displayNameAttr,
      'cn',
      'givenName',
      'sn',
      this.mailAttr,
    ];
    const entry = await this.ldapGetAttributes(dn, attrs);
    return entry ? this.getDisplayNameFromAttributes(entry) : null;
  }

  async generateSignature(dn: string): Promise<string | null> {
    const template = this.config.james_signature_template;
    if (!template) return null;

    // Get all attributes (needed for template placeholders)
    const entry = await this.ldapGetAttributes(dn);
    if (!entry) return null;

    // Replace all {attributeName} placeholders with LDAP values
    let signature = template;
    const placeholderRegex = /\{(\w+)\}/g;

    signature = signature.replace(
      placeholderRegex,
      (_match: string, attrName: string): string => {
        if (
          typeof attrName === 'string' &&
          entry &&
          typeof entry === 'object' &&
          Object.prototype.hasOwnProperty.call(entry, attrName)
        ) {
          return (
            this.attributeToString(
              (entry as Record<string, unknown>)[attrName]
            ) || ''
          );
        }
        return '';
      }
    );

    return signature;
  }

  /**
   * Name the user's default identity after the directory.
   *
   * The default identity is Twake Mail's: the deletable one with the lowest
   * sortOrder (`GET /users/{mail}/identities?default=true`). It is updated
   * when there is one and created otherwise. The server-set identity
   * (mayDelete false, named after the address) is never touched: a PUT on it
   * makes Twake Mail add, a few seconds later, a deletable identity named
   * "givenName sn", so the user ended up with two identities for one
   * address, one of them named after neither the directory's display name
   * nor the address.
   *
   * Calls for one address run one after the other: an add triggers this twice
   * (ldapadddone, then the display name "change" onChange publishes), and two
   * concurrent first calls would both find no default and both create one.
   *
   * `signatures` are written when `--james-signature-template` is not set:
   * those of the identity the user had before a rename.
   */
  async updateJamesIdentity(
    dn: string,
    mail: string,
    displayName: string,
    signatures: Signatures = {}
  ): Promise<void> {
    const previous = this.identityQueue.get(mail) ?? Promise.resolve();
    const current = previous.then(() =>
      this.doUpdateJamesIdentity(dn, mail, displayName, signatures)
    );
    this.identityQueue.set(mail, current);
    try {
      await current;
    } finally {
      if (this.identityQueue.get(mail) === current)
        this.identityQueue.delete(mail);
    }
  }

  private identityQueue: Map<string, Promise<void>> = new Map();

  private async doUpdateJamesIdentity(
    dn: string,
    mail: string,
    displayName: string,
    signatures: Signatures
  ): Promise<void> {
    const log = {
      plugin: this.name,
      event: 'onLdapDisplayNameChange',
      result: 'error',
      dn,
      mail,
      displayName,
    };

    // The read and the write are retried together: James answers the read
    // of a user it does not know yet 404, the same as "no identity", and
    // only the write tells the two apart
    for (let attempt = 1; ; attempt++) {
      try {
        // Step 1: the default identity, if the user has one
        const identitiesUrl = `${this.webadminUrl}/users/${mail}/identities`;
        const getRes = await this.requestLimit(() =>
          fetch(`${identitiesUrl}?default=true`, {
            method: 'GET',
            headers: this.createHeaders(),
          })
        );
        let defaultIdentity: Identity | undefined;
        if (getRes.ok) {
          defaultIdentity = pickDefaultIdentity(
            (await getRes.json()) as Identity[] | Identity
          );
        } else if (getRes.status !== 404) {
          const step = 'get_default_identity';
          if (this.shouldRetry(getRes.status, USER_NOT_SEEN_YET, attempt)) {
            await this.warnAndWait(log, step, attempt, getRes);
            continue;
          }
          this.logger.error({
            ...log,
            step,
            ...(attempt > 1 ? { attempts: attempt } : {}),
            http_status: getRes.status,
            http_status_text: getRes.statusText,
          });
          return;
        }

        // Step 2: Generate signature if template is configured
        const htmlSignature = await this.generateSignature(dn);

        // Step 3: update it, or create it
        const payload: Partial<Identity> & { name: string } =
          defaultIdentity?.id
            ? {
                id: defaultIdentity.id,
                email: defaultIdentity.email,
                name: displayName,
              }
            : { email: mail, name: displayName, sortOrder: 0 };
        if (htmlSignature) payload.htmlSignature = htmlSignature;
        else Object.assign(payload, signatures);

        const step = defaultIdentity?.id
          ? 'update_identity'
          : 'create_identity';
        const res = await this.requestLimit(() =>
          fetch(
            defaultIdentity?.id
              ? `${identitiesUrl}/${defaultIdentity.id}`
              : identitiesUrl,
            {
              method: defaultIdentity?.id ? 'PUT' : 'POST',
              headers: this.createHeaders('application/json'),
              body: JSON.stringify(payload),
            }
          )
        );

        if (res.ok) {
          this.logger.info({
            ...log,
            step,
            result: 'success',
            http_status: res.status,
          });
        } else if (this.shouldRetry(res.status, USER_NOT_SEEN_YET, attempt)) {
          await this.warnAndWait(log, step, attempt, res);
          continue;
        } else {
          this.logger.error({
            ...log,
            step,
            ...(attempt > 1 ? { attempts: attempt } : {}),
            http_status: res.status,
            http_status_text: res.statusText,
          });
        }
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        this.logger.error({ ...log, error: `${err}` });
      }
      return;
    }
  }

  /**
   * The signatures of an address's default identity, none when it has none
   * or James cannot be read.
   */
  private async defaultSignatures(mail: string): Promise<Signatures> {
    try {
      const res = await this.requestLimit(() =>
        fetch(`${this.webadminUrl}/users/${mail}/identities?default=true`, {
          method: 'GET',
          headers: this.createHeaders(),
        })
      );
      if (!res.ok) return {};
      const identity = pickDefaultIdentity(
        (await res.json()) as Identity[] | Identity
      );
      const signatures: Signatures = {};
      if (identity?.htmlSignature)
        signatures.htmlSignature = identity.htmlSignature;
      if (identity?.textSignature)
        signatures.textSignature = identity.textSignature;
      return signatures;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`Could not read the identities of ${mail}: ${err}`);
      return {};
    }
  }

  /**
   * The forwards the directory gives an entry, those James is to keep on its
   * address: none unless the directory owns forwards
   * (`--james-sync-forwards`).
   */
  private ownForwards(value: AttributesList[string] | undefined): string[] {
    return this.config.james_sync_forwards ? this.getAliases(value) : [];
  }

  /**
   * Remove the forwards James holds from an address an entry takes, but
   * those in `keep`: the entry's own. A rename leaves one from the old
   * address to the new, and its next owner would not get its mail.
   *
   * Runs whether forwards are synced or not: Twake Mail keeps a user's
   * forwards under their own address, and none can have been set yet on an
   * address the account is only now taking. The rename calls this before
   * James moves the user's forwards to the new address.
   */
  private async dropStaleForwards(
    dn: string,
    address: string,
    keep: string[]
  ): Promise<void> {
    let targets: string[];
    try {
      const res = await this.requestLimit(() =>
        fetch(`${this.webadminUrl}/address/forwards/${address}`, {
          method: 'GET',
          headers: this.createHeaders(),
        })
      );
      if (!res.ok) {
        // 404: no forward
        if (res.status !== 404)
          this.logger.warn({
            plugin: this.name,
            event: 'dropStaleForward',
            result: 'error',
            dn,
            address,
            step: 'list_forwards',
            http_status: res.status,
            http_status_text: res.statusText,
          });
        return;
      }
      const kept = keep.map(k => k.toLowerCase());
      targets = ((await res.json()) as { mailAddress: string }[])
        .map(t => t.mailAddress)
        .filter(t => t && !kept.includes(t.toLowerCase()));
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`Could not read the forwards of ${address}: ${err}`);
      return;
    }
    await Promise.all(
      targets.map(target =>
        this.callWebAdminApi(
          'dropStaleForward',
          `${this.webadminUrl}/address/forwards/${address}/targets/${target}`,
          'DELETE',
          dn,
          null,
          { address, forward: target }
        )
      )
    );
  }

  private async warnAndWait(
    log: object,
    step: string,
    attempt: number,
    res: { status: number; statusText: string }
  ): Promise<void> {
    this.logger.warn({
      ...log,
      step,
      result: 'retry',
      attempt,
      http_status: res.status,
      http_status_text: res.statusText,
    });
    await this.waitBeforeRetry(attempt);
  }

  /**
   * Delete user data via James WebAdmin API
   * Calls POST /users/{mail}?action=deleteData
   * Returns task information from the response
   */
  async deleteUserData(
    mail: string,
    fromStep?: string
  ): Promise<{ taskId: string } | null> {
    const log = {
      plugin: this.name,
      event: 'deleteUserData',
      mail,
      fromStep,
    };

    try {
      const url = new URL(`${this.webadminUrl}/users/${mail}`);
      url.searchParams.set('action', 'deleteData');
      if (fromStep) {
        url.searchParams.set('fromStep', fromStep);
      }

      const response = await this.requestLimit(() =>
        fetch(url.toString(), {
          method: 'POST',
          headers: this.createHeaders(),
        })
      );

      if (!response.ok) {
        this.logger.error({
          ...log,
          http_status: response.status,
          http_status_text: response.statusText,
        });
        return null;
      }

      const taskInfo = (await response.json()) as { taskId: string };

      this.logger.info({
        ...log,
        http_status: response.status,
        taskId: taskInfo.taskId,
      });

      return taskInfo;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error({ ...log, error: `${err}` });
      return null;
    }
  }

  /**
   * Extract mailbox type from group attributes
   * Returns: 'group', 'mailingList', 'teamMailbox', or null if not set
   */
  private getMailboxType(
    attributes: AttributesList
  ): 'group' | 'mailingList' | 'teamMailbox' | null {
    const mailboxType = attributes[this.mailboxTypeAttr];
    if (!mailboxType) return null;

    // Extract cn from DN (e.g., "cn=mailingList,ou=twakeMailboxType,...")
    const mailboxTypeDn = Array.isArray(mailboxType)
      ? String(mailboxType[0])
      : String(mailboxType);

    // Read as the directory reads the pointer: `CN=TeamMailbox,…` leads to
    // the same entry, and its check let it through
    const match = /^\s*cn\s*=\s*([^,]+)/i.exec(mailboxTypeDn);
    if (!match) return null;

    const type = match[1].trim().toLowerCase();
    return (
      (
        {
          group: 'group',
          mailinglist: 'mailingList',
          teammailbox: 'teamMailbox',
        } as const
      )[type] ?? null
    );
  }

  /**
   * Create a team mailbox in James
   */
  private async createTeamMailbox(
    dn: string,
    attributes: AttributesList,
    mailStr: string
  ): Promise<void> {
    const url = this.teamMailboxUrl(mailStr);

    // Create the team mailbox first: TMail answers 404 to an addMember
    // for a team mailbox that does not exist yet
    await this.callWebAdminApi('teamMailbox:create', url, 'PUT', dn, null, {
      teamMailbox: mailStr,
    });
    await this.teamMailboxMembers(dn, mailStr, 'PUT', members(attributes));
  }

  /**
   * Get email addresses for a list of member DNs
   * Uses p-limit to parallelize LDAP queries while limiting concurrency
   */
  async getMemberEmails(memberDns: string[]): Promise<string[]> {
    // Create promises for each member DN, with global concurrency limit
    const emailPromises = memberDns
      // Compared as a DN: the placeholder as the directory spells it is not
      // a person, and looking up its address is a query for nothing.
      .filter(
        memberDn => !isDummyMemberDn(memberDn, this.config.group_dummy_user)
      )
      .map(memberDn =>
        this.server.ldap.queryLimit(async () => {
          const entry = await this.ldapGetAttributes(memberDn, [this.mailAttr]);
          return entry ? this.attributeToString(entry[this.mailAttr]) : null;
        })
      );

    const results = await Promise.all(emailPromises);
    return results.filter((email): email is string => email !== null);
  }

  /**
   * Get the mail address for a group DN
   */
  async getGroupMail(groupDn: string): Promise<string | null> {
    const entry = await this.ldapGetAttributes(groupDn, ['mail']);
    return entry ? this.attributeToString(entry.mail) : null;
  }

  /**
   * Get the mailbox type for a group DN
   */
  async getGroupMailboxType(
    groupDn: string
  ): Promise<'group' | 'mailingList' | 'teamMailbox' | null> {
    try {
      // As the server: James is kept in step with the directory, whoever's write changed it
      const result = (await this.server.ldap.system.search(
        { paged: false, scope: 'base', attributes: [this.mailboxTypeAttr] },
        groupDn
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        return this.getMailboxType(result.searchEntries[0]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Could not get mailbox type for group ${groupDn}: ${errorMsg}`
      );
    }

    return null;
  }

  async _handleDelegationChange(
    dn: string,
    changes: ChangesToNotify
  ): Promise<void> {
    // Get the user's mail attribute from LDAP (only fetch mail attribute)
    const entry = await this.ldapGetAttributes(dn, [this.mailAttr]);
    if (!entry) {
      this.logger.warn({
        plugin: this.name,
        event: 'onLdapChange',
        dn,
        message: 'Could not find user entry to get mail attribute',
      });
      return;
    }

    const userMail = entry[this.mailAttr];
    if (!userMail || typeof userMail !== 'string') {
      this.logger.warn({
        plugin: this.name,
        event: 'onLdapChange',
        dn,
        message: 'User has no mail attribute, cannot manage delegation',
      });
      return;
    }

    const delegationAttr = this.config.delegation_attribute;
    if (!delegationAttr) return;

    const [oldDelegated, newDelegated] = changes[delegationAttr] || [];

    // Normalize values to arrays of DNs
    const oldDNs = this._normalizeToArray(oldDelegated as string);
    const newDNs = this._normalizeToArray(newDelegated as string);

    // Find added and removed delegations
    const addedDNs = newDNs.filter(delegateDN => !oldDNs.includes(delegateDN));
    const removedDNs = oldDNs.filter(
      delegateDN => !newDNs.includes(delegateDN)
    );

    // Fetch all delegate emails in parallel with global concurrency limit
    const addedEmailsPromises = addedDNs.map(delegateDN =>
      this.server.ldap.queryLimit(async () => {
        const email = await this._getDelegateEmail(delegateDN);
        return { dn: delegateDN, email };
      })
    );

    const removedEmailsPromises = removedDNs.map(delegateDN =>
      this.server.ldap.queryLimit(async () => {
        const email = await this._getDelegateEmail(delegateDN);
        return { dn: delegateDN, email };
      })
    );

    const [addedResults, removedResults] = await Promise.all([
      Promise.all(addedEmailsPromises),
      Promise.all(removedEmailsPromises),
    ]);

    // Process additions and removals in parallel
    const operations: Promise<void>[] = [];

    for (const { dn: delegateDN, email: delegateEmail } of addedResults) {
      if (delegateEmail) {
        operations.push(
          this.callWebAdminApi(
            'onLdapChange:addDelegation',
            `${this.webadminUrl}/users/${userMail}/authorizedUsers/${delegateEmail}`,
            'PUT',
            dn,
            null,
            { userMail, delegateEmail, delegateDN, action: 'add' },
            USER_NOT_SEEN_YET
          )
        );
      }
    }

    for (const { dn: delegateDN, email: delegateEmail } of removedResults) {
      if (delegateEmail) {
        operations.push(
          this.callWebAdminApi(
            'onLdapChange:removeDelegation',
            `${this.webadminUrl}/users/${userMail}/authorizedUsers/${delegateEmail}`,
            'DELETE',
            dn,
            null,
            { userMail, delegateEmail, delegateDN, action: 'remove' }
          )
        );
      }
    }

    await Promise.all(operations);
  }

  async _getDelegateEmail(dn: string): Promise<string | null> {
    const entry = await this.ldapGetAttributes(dn, [this.mailAttr]);

    if (!entry) {
      this.logger.warn({
        plugin: this.name,
        event: 'getDelegateEmail',
        dn,
        message: 'Could not resolve delegate DN to email',
      });
      return null;
    }

    return this.attributeToString(entry[this.mailAttr]);
  }

  _normalizeToArray(value: AttributeValue | null): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value as string[];
    return [value as string];
  }
}
