import fetch from 'node-fetch';
import pLimit from 'p-limit';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import { Hooks } from '../../hooks';
import type { ChangesToNotify } from '../ldap/onChange';

export default class James extends DmPlugin {
  name = 'james';
  roles: Role[] = ['consistency'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
    ldapGroups: 'core/ldap/groups',
  };

  // Cached configuration attributes
  private mailAttr: string;
  private quotaAttr: string;
  private aliasAttr: string;
  private displayNameAttr: string;

  // Concurrency limiter for James HTTP requests
  private jamesLimit: ReturnType<typeof pLimit>;

  constructor(server: DM) {
    super(server);

    // Initialize cached configuration attributes
    this.mailAttr = this.config.mail_attribute || 'mail';
    this.quotaAttr = this.config.quota_attribute || 'mailQuotaSize';
    this.aliasAttr = this.config.alias_attribute || 'mailAlternateAddress';
    this.displayNameAttr = this.config.display_name_attribute || 'displayName';

    // Initialize James HTTP concurrency limiter
    const jamesConcurrency =
      typeof this.config.james_concurrency === 'number'
        ? this.config.james_concurrency
        : 10;
    this.jamesLimit = pLimit(jamesConcurrency);
    this.logger.info(
      `James HTTP request concurrency limit set to ${jamesConcurrency}`
    );
  }

  /**
   * Normalize email alias - handle AD format (smtp:alias@domain.com)
   */
  private normalizeAlias(alias: string): string {
    if (alias.toLowerCase().startsWith('smtp:')) {
      return alias.substring(5);
    }
    return alias;
  }

  /**
   * Create HTTP headers with optional Authorization token
   */
  private createJamesHeaders(contentType?: string): {
    Authorization?: string;
    'Content-Type'?: string;
  } {
    const headers: { Authorization?: string; 'Content-Type'?: string } = {};
    if (this.config.james_webadmin_token) {
      headers.Authorization = `Bearer ${this.config.james_webadmin_token}`;
    }
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  /**
   * Extract aliases from LDAP attribute value
   */
  private getAliases(
    value: string | string[] | Buffer | Buffer[] | undefined
  ): string[] {
    if (!value) return [];
    const aliases = Array.isArray(value) ? value : [value];
    return aliases
      .map(a => (Buffer.isBuffer(a) ? a.toString('utf-8') : String(a)))
      .map(a => this.normalizeAlias(a));
  }

  hooks: Hooks = {
    ldapadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;

      const mail = attributes[this.mailAttr];
      const quota = attributes[this.quotaAttr];
      const aliases = attributes[this.aliasAttr];

      if (!mail) {
        // Not a user with mail, skip
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // Wait a bit to ensure James has created the user
      // eslint-disable-next-line no-undef -- setTimeout is a Node.js global
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Initialize quota if present
      if (quota) {
        const quotaNum = Array.isArray(quota)
          ? Number(quota[0])
          : Number(quota);
        if (!isNaN(quotaNum) && quotaNum > 0) {
          await this._try(
            'ldapadddone:quota',
            `${this.config.james_webadmin_url}/quota/users/${mailStr}/size`,
            'PUT',
            dn,
            quotaNum.toString(),
            { mail: mailStr, quota: quotaNum }
          );
        }
      }

      // Create aliases if present (parallelize API calls)
      if (aliases) {
        const aliasList = this.getAliases(aliases);
        await Promise.all(
          aliasList.map(alias =>
            this._try(
              'ldapadddone:alias',
              `${this.config.james_webadmin_url}/address/aliases/${mailStr}/sources/${alias}`,
              'PUT',
              dn,
              null,
              { mail: mailStr, alias }
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
    onLdapMailChange: async (dn: string, oldmail: string, newmail: string) => {
      // Skip if oldmail is empty/undefined (this is an add, not a change)
      // The mailbox will be created by ldapadddone
      if (!oldmail || oldmail === 'undefined') {
        this.logger.debug(
          `Skipping mail rename for ${dn}: oldmail is empty (mail attribute was added, not changed)`
        );
        return;
      }

      // Rename the mailbox
      await this._try(
        'onLdapMailChange',
        `${this.config.james_webadmin_url}/users/${oldmail}/rename/${newmail}?action=rename`,
        'POST',
        dn,
        null,
        { oldmail, newmail }
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
            // Delete old aliases and create new ones in parallel
            await Promise.all([
              ...aliases.map(alias =>
                this._try(
                  'onLdapMailChange-delete',
                  `${this.config.james_webadmin_url}/address/aliases/${oldmail}/sources/${alias}`,
                  'DELETE',
                  dn,
                  null,
                  { oldmail, alias }
                )
              ),
              ...aliases.map(alias =>
                this._try(
                  'onLdapMailChange-create',
                  `${this.config.james_webadmin_url}/address/aliases/${newmail}/sources/${alias}`,
                  'PUT',
                  dn,
                  null,
                  { newmail, alias }
                )
              ),
            ]);
          }
        }
      } catch (err) {
        // Silently ignore if user has no aliases attribute
        this.logger.debug('Could not fetch aliases for mail change:', err);
      }
    },
    onLdapAliasChange: async (
      dn: string,
      mail: string,
      oldAliases: string[],
      newAliases: string[]
    ) => {
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
          this._try(
            'onLdapAliasChange-delete',
            `${this.config.james_webadmin_url}/address/aliases/${mail}/sources/${alias}`,
            'DELETE',
            dn,
            null,
            { mail, alias, action: 'delete' }
          )
        ),
        ...toAdd.map(alias =>
          this._try(
            'onLdapAliasChange-add',
            `${this.config.james_webadmin_url}/address/aliases/${mail}/sources/${alias}`,
            'PUT',
            dn,
            null,
            { mail, alias, action: 'add' }
          )
        ),
      ]);
    },
    onLdapQuotaChange: (
      dn: string,
      mail: string,
      oldQuota: number,
      newQuota: number
    ) => {
      return this._try(
        'onLdapQuotaChange',
        `${this.config.james_webadmin_url}/quota/users/${mail}/size`,
        'PUT',
        dn,
        newQuota.toString(),
        { oldQuota, newQuota }
      );
    },
    onLdapForwardChange: async (
      dn: string,
      mail: string,
      oldForwards: string[],
      newForwards: string[]
    ) => {
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
          this._try(
            'onLdapForwardChange-delete',
            `${this.config.james_webadmin_url}/domains/${domain}/forwards/${mail}/${forward}`,
            'DELETE',
            dn,
            null,
            { mail, forward, domain, action: 'delete' }
          )
        ),
        ...toAdd.map(forward =>
          this._try(
            'onLdapForwardChange-add',
            `${this.config.james_webadmin_url}/domains/${domain}/forwards/${mail}/${forward}`,
            'PUT',
            dn,
            null,
            { mail, forward, domain, action: 'add' }
          )
        ),
      ]);
    },

    onLdapChange: async (dn: string, changes: ChangesToNotify) => {
      if (
        this.config.delegation_attribute &&
        changes[this.config.delegation_attribute]
      ) {
        await this._handleDelegationChange(dn, changes);
      }
    },

    onLdapDisplayNameChange: async (
      dn: string
      // oldDisplayName: string | null,
      // newDisplayName: string | null
    ) => {
      // Get mail and display name attributes using cached ldapGetAttributes
      const attrs = [
        this.mailAttr,
        this.displayNameAttr,
        'cn',
        'givenName',
        'sn',
      ];

      const entry = await this.ldapGetAttributes(dn, attrs);
      if (!entry) {
        this.logger.warn(
          `Cannot update James identity: entry not found for ${dn}`
        );
        return;
      }

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

    // Group/mailing list hooks
    ldapgroupadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;
      const mail = attributes.mail as string | string[] | undefined;

      // Only handle groups with a mail attribute
      if (!mail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      const mailboxType = this.getMailboxType(attributes);
      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

      // Dispatch based on mailbox type
      if (mailboxType === 'teamMailbox') {
        // Validate team mailbox is NOT in mailing list branches
        const branches = this.config.james_mailing_list_branch || [];
        if (branches.length > 0 && this.isInAllowedBranches(dn, branches)) {
          this.logger.error({
            plugin: this.name,
            event: 'ldapgroupadddone',
            dn,
            mailboxType: 'teamMailbox',
            error: `Team mailbox cannot be in mailing list branches: ${branches.join(', ')}`,
          });
          return;
        }
        await this.createTeamMailbox(dn, attributes, mailStr);
      } else if (mailboxType === 'mailingList' || mailboxType === null) {
        // Validate mailing list is in allowed branches
        const branches = this.config.james_mailing_list_branch || [];
        if (branches.length > 0 && !this.isInAllowedBranches(dn, branches)) {
          this.logger.error({
            plugin: this.name,
            event: 'ldapgroupadddone',
            dn,
            mailboxType: mailboxType || 'mailingList (default)',
            error: `Mailing list must be in allowed branches: ${branches.join(', ')}`,
          });
          return;
        }
        await this.createMailingList(dn, attributes, mailStr);
      }
      // If mailboxType === 'group', do nothing (simple group without mailbox)
    },

    ldapgroupmodifydone: async (
      args: [
        string,
        {
          add?: AttributesList;
          replace?: AttributesList;
          delete?: string[] | AttributesList;
        },
        number,
      ]
    ) => {
      const [dn, changes] = args;

      // Check if mailboxType is being changed
      if (changes.replace?.twakeMailboxType || changes.add?.twakeMailboxType) {
        await this.handleMailboxTypeTransition(dn, changes);
        return; // Transition handles everything including members
      }

      // Get the group's mail address and mailbox type
      const groupMail = await this.getGroupMail(dn);
      if (!groupMail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      const mailboxType = await this.getGroupMailboxType(dn);
      const isTeamMailbox = mailboxType === 'teamMailbox';

      // Determine the API endpoint based on mailbox type
      const domain = isTeamMailbox ? this.extractMailDomain(groupMail) : null;

      // Handle member additions and deletions in parallel
      const operations: Promise<void>[] = [];

      if (changes.add?.member) {
        const addMember = changes.add.member as string | string[];
        const membersToAdd = Array.isArray(addMember) ? addMember : [addMember];
        const memberMails = await this.getMemberEmails(membersToAdd);

        operations.push(
          ...memberMails.map(memberMail => {
            if (isTeamMailbox && domain) {
              return this._try(
                'ldapgroupmodifydone:teamMailbox',
                `${this.config.james_webadmin_url}/domains/${domain}/team-mailboxes/${groupMail}/members/${memberMail}`,
                'PUT',
                dn,
                null,
                { domain, groupMail, memberMail, action: 'add' }
              );
            } else {
              return this._try(
                'ldapgroupmodifydone:mailingList',
                `${this.config.james_webadmin_url}/address/groups/${groupMail}/${memberMail}`,
                'PUT',
                dn,
                null,
                { groupMail, memberMail, action: 'add' }
              );
            }
          })
        );
      }

      if (this.isAttributesList(changes.delete)) {
        const deleteMember = changes.delete.member as
          | string
          | string[]
          | undefined;
        if (deleteMember) {
          const membersToDelete = Array.isArray(deleteMember)
            ? deleteMember
            : [deleteMember];
          const memberMails = await this.getMemberEmails(membersToDelete);

          operations.push(
            ...memberMails.map(memberMail => {
              if (isTeamMailbox && domain) {
                return this._try(
                  'ldapgroupmodifydone:teamMailbox',
                  `${this.config.james_webadmin_url}/domains/${domain}/team-mailboxes/${groupMail}/members/${memberMail}`,
                  'DELETE',
                  dn,
                  null,
                  { domain, groupMail, memberMail, action: 'delete' }
                );
              } else {
                return this._try(
                  'ldapgroupmodifydone:mailingList',
                  `${this.config.james_webadmin_url}/address/groups/${groupMail}/${memberMail}`,
                  'DELETE',
                  dn,
                  null,
                  { groupMail, memberMail, action: 'delete' }
                );
              }
            })
          );
        }
      }

      await Promise.all(operations);
    },

    ldapgroupdeletedone: async (dn: string) => {
      // Get the group's mail address and mailbox type before deletion
      const groupMail = await this.getGroupMail(dn);
      if (!groupMail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      const mailboxType = await this.getGroupMailboxType(dn);

      if (mailboxType === 'teamMailbox') {
        // For team mailboxes, remove all members but preserve the mailbox
        await this.removeAllTeamMailboxMembers(dn, groupMail);
      } else {
        // Delete the entire address group from James (mailing list)
        await this._try(
          'ldapgroupdeletedone:mailingList',
          `${this.config.james_webadmin_url}/address/groups/${groupMail}`,
          'DELETE',
          dn,
          null,
          { groupMail }
        );
      }
    },
  };

  /**
   * Handle mailbox type transitions when twakeMailboxType changes
   */
  private async handleMailboxTypeTransition(
    dn: string,
    changes: {
      add?: AttributesList;
      replace?: AttributesList;
      delete?: string[] | AttributesList;
    }
  ): Promise<void> {
    // Get current group attributes
    const attributes = await this.ldapGetAttributes(dn, [
      'mail',
      'member',
      'twakeMailboxType',
    ]);

    if (!attributes) {
      this.logger.error({
        plugin: this.name,
        event: 'handleMailboxTypeTransition',
        dn,
        error: 'Could not fetch group attributes',
      });
      return;
    }
    const mail = attributes.mail;
    if (!mail) {
      this.logger.debug(
        `Group ${dn} has no mail attribute, skipping mailbox type transition`
      );
      return;
    }

    const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);

    // Determine old and new mailbox types
    const newMailboxTypeDn =
      changes.replace?.twakeMailboxType || changes.add?.twakeMailboxType;
    const newMailboxTypeStr = Array.isArray(newMailboxTypeDn)
      ? String(newMailboxTypeDn[0])
      : String(newMailboxTypeDn);

    const newType = this.getMailboxType({
      twakeMailboxType: newMailboxTypeStr,
    });
    const oldType = this.getMailboxType(attributes);

    this.logger.info({
      plugin: this.name,
      event: 'handleMailboxTypeTransition',
      dn,
      mail: mailStr,
      oldType: oldType || 'none',
      newType: newType || 'none',
    });

    // Handle transition based on old and new types
    if (oldType === newType) {
      // No actual change
      return;
    }

    // Cleanup old mailbox type
    if (oldType === 'mailingList') {
      await this.deleteMailingList(dn, mailStr);
    } else if (oldType === 'teamMailbox') {
      // Remove all members but preserve the mailbox
      await this.removeAllTeamMailboxMembers(dn, mailStr);
    }

    // Setup new mailbox type with validation
    if (newType === 'mailingList') {
      // Validate mailing list is in allowed branches
      const branches = this.config.james_mailing_list_branch || [];
      if (branches.length > 0 && !this.isInAllowedBranches(dn, branches)) {
        this.logger.error({
          plugin: this.name,
          event: 'handleMailboxTypeTransition',
          dn,
          newType,
          error: `Mailing list must be in allowed branches: ${branches.join(', ')}`,
        });
        return;
      }
      await this.createMailingList(dn, attributes, mailStr);
    } else if (newType === 'teamMailbox') {
      // Validate team mailbox is NOT in mailing list branches
      const branches = this.config.james_mailing_list_branch || [];
      if (branches.length > 0 && this.isInAllowedBranches(dn, branches)) {
        this.logger.error({
          plugin: this.name,
          event: 'handleMailboxTypeTransition',
          dn,
          newType,
          error: `Team mailbox cannot be in mailing list branches: ${branches.join(', ')}`,
        });
        return;
      }
      await this.createTeamMailbox(dn, attributes, mailStr);
    }
    // If newType === 'group', nothing to create (simple group)
  }

  /**
   * Helper to convert LDAP attribute value to string
   */
  private attributeToString(value: unknown): string | null {
    if (!value) return null;
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : null;
    }
    return String(value as string | Buffer);
  }

  /**
   * Generic LDAP search utility to fetch specific attributes from a DN
   * Reduces code duplication across multiple methods
   * @param dn - The DN to fetch attributes from
   * @param attributes - Optional array of attribute names to fetch.
   *                     If undefined or empty, fetches all attributes (*)
   */
  private async ldapGetAttributes(
    dn: string,
    attributes?: string[]
  ): Promise<AttributesList | null> {
    try {
      // If attributes is undefined or empty, fetch all attributes
      const searchAttrs =
        attributes && attributes.length > 0 ? attributes : undefined;

      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: searchAttrs },
        dn
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        return result.searchEntries[0] as AttributesList;
      }
      return null;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`Could not fetch attributes from DN ${dn}: ${err}`);
      return null;
    }
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

  async updateJamesIdentity(
    dn: string,
    mail: string,
    displayName: string
  ): Promise<void> {
    const log = {
      plugin: this.name,
      event: 'onLdapDisplayNameChange',
      result: 'error',
      dn,
      mail,
      displayName,
    };

    try {
      // Step 1: Get user identities
      const identitiesUrl = `${this.config.james_webadmin_url}/jmap/identities/${mail}`;
      const getRes = await this.jamesLimit(() =>
        fetch(identitiesUrl, {
          method: 'GET',
          headers: this.createJamesHeaders(),
        })
      );
      if (!getRes.ok) {
        this.logger.error({
          ...log,
          step: 'get_identities',
          http_status: getRes.status,
          http_status_text: getRes.statusText,
        });
        return;
      }

      const identities = (await getRes.json()) as Array<{
        id: string;
        name: string;
        email: string;
      }>;

      // Step 2: Find default identity (first one or the one matching the email)
      const defaultIdentity =
        identities.find(id => id.email === mail) || identities[0];

      if (!defaultIdentity) {
        this.logger.warn({
          ...log,
          step: 'find_identity',
          message: 'No identity found for user',
        });
        return;
      }

      // Step 3: Generate signature if template is configured
      const htmlSignature = await this.generateSignature(dn);

      // Step 4: Update identity name and signature
      const updateUrl = `${this.config.james_webadmin_url}/jmap/identities/${mail}/${defaultIdentity.id}`;

      const updatePayload: {
        id: string;
        email: string;
        name: string;
        htmlSignature?: string;
      } = {
        id: defaultIdentity.id,
        email: defaultIdentity.email,
        name: displayName,
      };

      if (htmlSignature) {
        updatePayload.htmlSignature = htmlSignature;
      }

      const updateRes = await this.jamesLimit(() =>
        fetch(updateUrl, {
          method: 'PUT',
          headers: this.createJamesHeaders('application/json'),
          body: JSON.stringify(updatePayload),
        })
      );

      if (!updateRes.ok) {
        this.logger.error({
          ...log,
          step: 'update_identity',
          http_status: updateRes.status,
          http_status_text: updateRes.statusText,
        });
      } else {
        this.logger.info({
          ...log,
          result: 'success',
          http_status: updateRes.status,
        });
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error({ ...log, error: `${err}` });
    }
  }

  /**
   * Type guard to check if delete operation is an AttributesList
   */
  private isAttributesList(
    value: string[] | AttributesList | undefined
  ): value is AttributesList {
    return (
      value !== undefined && typeof value === 'object' && !Array.isArray(value)
    );
  }

  /**
   * Extract mailbox type from group attributes
   * Returns: 'group', 'mailingList', 'teamMailbox', or null if not set
   */
  private getMailboxType(
    attributes: AttributesList
  ): 'group' | 'mailingList' | 'teamMailbox' | null {
    const mailboxType = attributes.twakeMailboxType;
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
   * Validate that a DN is within one of the allowed branches
   */
  private isInAllowedBranches(dn: string, branches: string[]): boolean {
    if (!branches || branches.length === 0) return true; // No restriction
    return branches.some(branch => dn === branch || dn.endsWith(',' + branch));
  }

  /**
   * Extract domain from email address
   */
  private extractMailDomain(email: string): string | null {
    const parts = email.split('@');
    return parts.length === 2 ? parts[1] : null;
  }

  /**
   * Create a mailing list in James
   */
  private async createMailingList(
    dn: string,
    attributes: AttributesList,
    mailStr: string
  ): Promise<void> {
    const members = (attributes.member as string | string[] | undefined) || [];
    const memberList: string[] = Array.isArray(members) ? members : [members];

    this.logger.debug(
      `Creating mailing list ${mailStr} in James with ${memberList.length} members`
    );

    // Get email addresses for all members
    const memberMails = await this.getMemberEmails(memberList);

    // Add each member to the James address group (parallelize)
    await Promise.all(
      memberMails.map(memberMail =>
        this._try(
          'ldapgroupadddone:mailingList',
          `${this.config.james_webadmin_url}/address/groups/${mailStr}/${memberMail}`,
          'PUT',
          dn,
          null,
          { groupMail: mailStr, memberMail }
        )
      )
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

    const members = (attributes.member as string | string[] | undefined) || [];
    const memberList: string[] = Array.isArray(members) ? members : [members];

    this.logger.debug(
      `Creating team mailbox ${mailStr} in James with ${memberList.length} members`
    );

    // Get email addresses for all members
    const memberMails = await this.getMemberEmails(memberList);

    // Create team mailbox and add members (parallelize)
    const operations: Promise<void>[] = [];

    // Create the team mailbox itself
    operations.push(
      this._try(
        'ldapgroupadddone:teamMailbox:create',
        `${this.config.james_webadmin_url}/domains/${domain}/team-mailboxes/${mailStr}`,
        'PUT',
        dn,
        null,
        { domain, teamMailbox: mailStr }
      )
    );

    // Add each member
    for (const memberMail of memberMails) {
      operations.push(
        this._try(
          'ldapgroupadddone:teamMailbox:addMember',
          `${this.config.james_webadmin_url}/domains/${domain}/team-mailboxes/${mailStr}/members/${memberMail}`,
          'PUT',
          dn,
          null,
          { domain, teamMailbox: mailStr, memberMail }
        )
      );
    }

    await Promise.all(operations);
  }

  /**
   * Delete a team mailbox from James
   */
  private async deleteTeamMailbox(dn: string, mailStr: string): Promise<void> {
    const domain = this.extractMailDomain(mailStr);
    if (!domain) {
      this.logger.error({
        plugin: this.name,
        event: 'deleteTeamMailbox',
        dn,
        mail: mailStr,
        error: 'Cannot extract domain from mail address',
      });
      return;
    }

    await this._try(
      'ldapgroupdeletedone:teamMailbox',
      `${this.config.james_webadmin_url}/domains/${domain}/team-mailboxes/${mailStr}`,
      'DELETE',
      dn,
      null,
      { domain, teamMailbox: mailStr }
    );
  }

  /**
   * Remove all members from a team mailbox (without deleting it)
   * This preserves the mailbox for potential future use
   */
  private async removeAllTeamMailboxMembers(
    dn: string,
    mailStr: string
  ): Promise<void> {
    const domain = this.extractMailDomain(mailStr);
    if (!domain) {
      this.logger.error({
        plugin: this.name,
        event: 'removeAllTeamMailboxMembers',
        dn,
        mail: mailStr,
        error: 'Cannot extract domain from mail address',
      });
      return;
    }

    // Get current members from LDAP
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['member'] },
        dn
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        const members =
          (result.searchEntries[0].member as string | string[] | undefined) ||
          [];
        const memberList: string[] = Array.isArray(members)
          ? members
          : [members];
        const memberMails = await this.getMemberEmails(memberList);

        // Remove each member
        await Promise.all(
          memberMails.map(memberMail =>
            this._try(
              'removeAllTeamMailboxMembers',
              `${this.config.james_webadmin_url}/domains/${domain}/team-mailboxes/${mailStr}/members/${memberMail}`,
              'DELETE',
              dn,
              null,
              { domain, teamMailbox: mailStr, memberMail }
            )
          )
        );

        this.logger.info({
          plugin: this.name,
          event: 'removeAllTeamMailboxMembers',
          dn,
          teamMailbox: mailStr,
          membersRemoved: memberMails.length,
          message: 'All members removed from team mailbox (mailbox preserved)',
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to remove members from team mailbox ${mailStr}: ${errorMsg}`
      );
    }
  }

  /**
   * Delete a mailing list from James
   */
  private async deleteMailingList(dn: string, mailStr: string): Promise<void> {
    await this._try(
      'deleteMailingList',
      `${this.config.james_webadmin_url}/address/groups/${mailStr}`,
      'DELETE',
      dn,
      null,
      { groupMail: mailStr }
    );
  }

  /**
   * Get email addresses for a list of member DNs
   * Uses p-limit to parallelize LDAP queries while limiting concurrency
   */
  async getMemberEmails(memberDns: string[]): Promise<string[]> {
    // Create promises for each member DN, with global concurrency limit
    const emailPromises = memberDns
      .filter(memberDn => memberDn !== this.config.group_dummy_user)
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
        { paged: false, scope: 'base', attributes: ['twakeMailboxType'] },
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
          this._try(
            'onLdapChange:addDelegation',
            `${this.config.james_webadmin_url}/users/${userMail}/authorizedUsers/${delegateEmail}`,
            'PUT',
            dn,
            null,
            { userMail, delegateEmail, delegateDN, action: 'add' }
          )
        );
      }
    }

    for (const { dn: delegateDN, email: delegateEmail } of removedResults) {
      if (delegateEmail) {
        operations.push(
          this._try(
            'onLdapChange:removeDelegation',
            `${this.config.james_webadmin_url}/users/${userMail}/authorizedUsers/${delegateEmail}`,
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

  async _try(
    hookname: string,
    url: string,
    method: string,
    dn: string,
    body: string | null,
    fields: object
  ): Promise<void> {
    return this.jamesLimit(async () => {
      // Prepare log
      const log = {
        plugin: this.name,
        event: `${hookname}`,
        result: 'error',
        dn,
        ...fields,
      };
      try {
        const opts: {
          method: string;
          body?: string | null;
          headers?: { Authorization?: string };
        } = { method };
        if (body) Object.assign(opts, { body });
        if (this.config.james_webadmin_token) {
          if (!opts.headers) opts.headers = {};
          opts.headers.Authorization = `Bearer ${this.config.james_webadmin_token}`;
        }
        const res = await fetch(url, opts);
        if (!res.ok) {
          // 409 Conflict is acceptable for alias creation - may already exist
          // (e.g., James automatically creates alias when renaming user)
          if (res.status === 409 && hookname.includes('Alias')) {
            this.logger.debug({
              ...log,
              result: 'already_exists',
              http_status: res.status,
              http_status_text: res.statusText,
            });
          } else {
            this.logger.error({
              ...log,
              http_status: res.status,
              http_status_text: res.statusText,
            });
          }
        } else {
          this.logger.info({
            ...log,
            result: 'success',
            http_status: res.status,
          });
        }
      } catch (err) {
        this.logger.error({
          ...log,
          error: err,
        });
      }
    });
  }
}
