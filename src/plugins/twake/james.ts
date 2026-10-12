import fetch from 'node-fetch';
import type { Express, Request, Response } from 'express';

import TwakePlugin from '../../abstract/twakePlugin';
import { type Role, asyncHandler } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import { Hooks } from '../../hooks';
import type { ChangesToNotify } from '../ldap/onChange';
import { wantJson } from '../../lib/expressFormatedResponses';
import {
  escapeLdapFilter,
  isDummyMemberDn,
  normalizeDn,
} from '../../lib/utils';

/**
 * What James WebAdmin answers about a user missing from its users
 * repository. Read through LDAP, that repository can lag behind the write
 * that created or renamed the user, so a call about that user is retried on
 * these, see docs/usage/plugins/integrations/james-mail.md#replication-lag
 */
const USER_NOT_SEEN_YET = [400, 404] as const;

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
const members = (entry: AttributesList | null): string[] => {
  const value = entry?.member;
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
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

export default class James extends TwakePlugin {
  name = 'james';
  roles: Role[] = ['consistency', 'api'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
    ldapGroups: 'core/ldap/groups',
  };

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
     *           code: 400
     *   '404':
     *     description: User not found in LDAP, or quota entry absent in James.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: User alice not found
     *           code: 404
     *   '502':
     *     description: James WebAdmin API is unreachable or returned an error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *         example:
     *           error: "Failed to retrieve quota from James: Bad Gateway"
     *           code: 502
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
      const userResult = await this.server.ldap.search(
        {
          scope: 'sub',
          filter: `(uid=${escapedUsername})`,
          paged: false,
          attributes: [this.mailAttr],
        },
        this.config.ldap_base || ''
      );

      const userEntry = (userResult as SearchResult).searchEntries?.[0];
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
    ldapadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;

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
        const quotaNum = Array.isArray(quota)
          ? Number(quota[0])
          : Number(quota);
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
          this.getAliases(attributes[this.forwardAttr])
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
    },
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

      // Skip if oldmail is empty/null (this is an add, not a change)
      // The mailbox will be created by ldapadddone
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
        this.getAliases(entry?.[this.forwardAttr])
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
        const entry = (await this.server.ldap.search(
          { paged: false, scope: 'base', attributes: [this.aliasAttr] },
          dn
        )) as SearchResult;

        if (entry.searchEntries && entry.searchEntries.length > 0) {
          const aliases = this.getAliases(
            entry.searchEntries[0][this.aliasAttr]
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
      return this.callWebAdminApi(
        'onLdapQuotaChange',
        `${this.webadminUrl}/quota/users/${mail}/size`,
        'PUT',
        dn,
        newQuota.toString(),
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
    onLdapEntryChange: (_dn, before, after) =>
      this.followTeamMailbox(
        before as AttributesList | null,
        after as AttributesList | null
      ),
  };

  /**
   * The address of the team mailbox an entry stands for, and whether it is
   * refused for lying in a mailing list branch.
   */
  private teamMailboxOf(
    entry: AttributesList | null
  ): { mail: string; refused: boolean } | null {
    if (!entry || this.getMailboxType(entry) !== 'teamMailbox') return null;
    const mail = this.attributeToString(entry.mail);
    if (!mail) return null;
    const dn = String(entry.dn);
    const branches = this.config.james_mailing_list_branch || [];
    return {
      mail,
      refused: branches.some(
        branch => dn === branch || dn.endsWith(',' + branch)
      ),
    };
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
    if (is?.refused && !was?.refused)
      this.logger.error({
        plugin: this.name,
        event: 'teamMailbox',
        dn,
        error: `Team mailbox cannot be in mailing list branches: ${(this.config.james_mailing_list_branch || []).join(', ')}`,
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

  private async teamMailboxMembers(
    dn: string,
    mail: string,
    method: 'PUT' | 'DELETE',
    memberDns: string[]
  ): Promise<void> {
    const domain = this.extractMailDomain(mail);
    if (!domain || !memberDns.length) return;
    const memberMails = await this.getMemberEmails(memberDns);
    await Promise.all(
      memberMails.map(memberMail =>
        this.callWebAdminApi(
          `teamMailbox:${method === 'PUT' ? 'addMember' : 'removeMember'}`,
          `${this.webadminUrl}/domains/${domain}/team-mailboxes/${mail}/members/${memberMail}`,
          method,
          dn,
          null,
          { domain, teamMailbox: mail, memberMail }
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
   * Remove the forwards James holds from an address an entry takes, but
   * those in `keep`: the entry's own. A rename leaves one from the old
   * address to the new, and its next owner would not get its mail.
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
      // 404: no forward
      if (!res.ok) return;
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

    const match = mailboxTypeDn.match(/^cn=([^,]+)/);
    if (!match) return null;

    const type = match[1];
    if (type === 'group' || type === 'mailingList' || type === 'teamMailbox') {
      return type;
    }

    return null;
  }

  /**
   * Create a team mailbox in James
   */
  private async createTeamMailbox(
    dn: string,
    attributes: AttributesList,
    mailStr: string
  ): Promise<void> {
    const domain = this.extractMailDomain(mailStr);
    if (!domain) {
      this.logger.error({
        plugin: this.name,
        event: 'createTeamMailbox',
        dn,
        mail: mailStr,
        error: 'Cannot extract domain from mail address',
      });
      return;
    }

    // Create the team mailbox first: TMail answers 404 to an addMember
    // for a team mailbox that does not exist yet
    await this.callWebAdminApi(
      'teamMailbox:create',
      `${this.webadminUrl}/domains/${domain}/team-mailboxes/${mailStr}`,
      'PUT',
      dn,
      null,
      { domain, teamMailbox: mailStr }
    );
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
      const result = (await this.server.ldap.search(
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
