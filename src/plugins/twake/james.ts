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

  // Limit concurrent LDAP queries to avoid overwhelming the server
  private ldapQueryLimit!: ReturnType<typeof pLimit>;

  constructor(server: DM) {
    super(server);
    // Initialize concurrency limiter with config value
    const concurrency = this.config.ldap_concurrency || 10;
    this.ldapQueryLimit = pLimit(concurrency);
    this.logger.debug(`LDAP query concurrency limit set to ${concurrency}`);
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

  /**
   * Extract domain from email address
   */
  private extractDomain(email: string): string | null {
    const parts = email.split('@');
    return parts.length === 2 ? parts[1] : null;
  }

  hooks: Hooks = {
    ldapadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;
      const mailAttr = this.config.mail_attribute || 'mail';
      const quotaAttr = this.config.quota_attribute || 'mailQuotaSize';
      const aliasAttr = this.config.alias_attribute || 'mailAlternateAddress';

      const mail = attributes[mailAttr];
      const quota = attributes[quotaAttr];
      const aliases = attributes[aliasAttr];

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
        const aliasAttr = this.config.alias_attribute || 'mailAlternateAddress';
        const entry = (await this.server.ldap.search(
          { paged: false, scope: 'base', attributes: [aliasAttr] },
          dn
        )) as SearchResult;

        if (entry.searchEntries && entry.searchEntries.length > 0) {
          const aliases = this.getAliases(entry.searchEntries[0][aliasAttr]);

          // Only process if user has aliases
          if (aliases.length > 0) {
            // Delete old aliases and create new ones
            for (const alias of aliases) {
              // Delete old alias pointing to old mail
              await this._try(
                'onLdapMailChange-delete',
                `${this.config.james_webadmin_url}/address/aliases/${oldmail}/sources/${alias}`,
                'DELETE',
                dn,
                null,
                { oldmail, alias }
              );

              // Create new alias pointing to new mail
              await this._try(
                'onLdapMailChange-create',
                `${this.config.james_webadmin_url}/address/aliases/${newmail}/sources/${alias}`,
                'PUT',
                dn,
                null,
                { newmail, alias }
              );
            }
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
      const domain = this.extractDomain(mail);
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
      // Get mail and display name in a single LDAP query
      try {
        const attrs = [
          this.config.mail_attribute || 'mail',
          this.config.display_name_attribute || 'displayName',
          'cn',
          'givenName',
          'sn',
        ];
        const result = (await this.server.ldap.search(
          { paged: false, scope: 'base', attributes: attrs },
          dn
        )) as import('../../lib/ldapActions').SearchResult;

        if (!result.searchEntries || result.searchEntries.length === 0) {
          this.logger.warn(
            `Cannot update James identity: entry not found for ${dn}`
          );
          return;
        }

        const entry = result.searchEntries[0];
        const mailAttr = this.config.mail_attribute || 'mail';
        const mail = this.attributeToString(entry[mailAttr]);

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
      } catch (err) {
        this.logger.error(
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          `Failed to process display name change for ${dn}: ${err}`
        );
      }
    },

    // Group/mailing list hooks
    ldapgroupadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;
      const mail = attributes.mail as string | string[] | undefined;

      // Only handle groups with a mail attribute (mailing lists)
      if (!mail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);
      const members =
        (attributes.member as string | string[] | undefined) || [];
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
            'ldapgroupadddone',
            `${this.config.james_webadmin_url}/address/groups/${mailStr}/${memberMail}`,
            'PUT',
            dn,
            null,
            { groupMail: mailStr, memberMail }
          )
        )
      );
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

      // Get the group's mail address
      const groupMail = await this.getGroupMail(dn);
      if (!groupMail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      // Handle member additions and deletions in parallel
      const operations: Promise<void>[] = [];

      if (changes.add?.member) {
        const addMember = changes.add.member as string | string[];
        const membersToAdd = Array.isArray(addMember) ? addMember : [addMember];
        const memberMails = await this.getMemberEmails(membersToAdd);

        operations.push(
          ...memberMails.map(memberMail =>
            this._try(
              'ldapgroupmodifydone',
              `${this.config.james_webadmin_url}/address/groups/${groupMail}/${memberMail}`,
              'PUT',
              dn,
              null,
              { groupMail, memberMail, action: 'add' }
            )
          )
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
            ...memberMails.map(memberMail =>
              this._try(
                'ldapgroupmodifydone',
                `${this.config.james_webadmin_url}/address/groups/${groupMail}/${memberMail}`,
                'DELETE',
                dn,
                null,
                { groupMail, memberMail, action: 'delete' }
              )
            )
          );
        }
      }

      await Promise.all(operations);
    },

    ldapgroupdeletedone: async (dn: string) => {
      // Get the group's mail address before deletion
      const groupMail = await this.getGroupMail(dn);
      if (!groupMail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      // Delete the entire address group from James
      await this._try(
        'ldapgroupdeletedone',
        `${this.config.james_webadmin_url}/address/groups/${groupMail}`,
        'DELETE',
        dn,
        null,
        { groupMail }
      );
    },
  };

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
   * Extract display name from LDAP attributes
   * Fallback logic: displayName → cn → givenName+sn → mail
   */
  private getDisplayNameFromAttributes(
    attributes: import('../../lib/ldapActions').AttributesList
  ): string | null {
    const displayNameAttr = this.config.display_name_attribute || 'displayName';
    const mailAttr = this.config.mail_attribute || 'mail';

    // 1. Try displayName first
    const displayName = this.attributeToString(attributes[displayNameAttr]);
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
    const mail = this.attributeToString(attributes[mailAttr]);
    if (mail) return mail;

    return null;
  }

  async getMailFromDN(dn: string): Promise<string | null> {
    try {
      const mailAttr = this.config.mail_attribute || 'mail';
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: [mailAttr] },
        dn
      )) as import('../../lib/ldapActions').SearchResult;
      if (result.searchEntries && result.searchEntries.length > 0) {
        const mail = result.searchEntries[0][mailAttr];
        return mail ? String(mail) : null;
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error(`Failed to get mail from DN ${dn}: ${err}`);
    }
    return null;
  }

  async getDisplayNameFromDN(dn: string): Promise<string | null> {
    try {
      const attrs = [
        this.config.display_name_attribute || 'displayName',
        'cn',
        'givenName',
        'sn',
        this.config.mail_attribute || 'mail',
      ];
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: attrs },
        dn
      )) as import('../../lib/ldapActions').SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        return this.getDisplayNameFromAttributes(result.searchEntries[0]);
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error(`Failed to get display name from DN ${dn}: ${err}`);
    }
    return null;
  }

  async generateSignature(dn: string): Promise<string | null> {
    const template = this.config.james_signature_template;
    if (!template) return null;

    try {
      // Get all attributes that might be used in the template
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as import('../../lib/ldapActions').SearchResult;

      if (!result.searchEntries || result.searchEntries.length === 0) {
        return null;
      }

      const entry: AttributesList = result.searchEntries[0] as AttributesList;

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
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error(`Failed to generate signature for DN ${dn}: ${err}`);
      return null;
    }
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
      const headers: { Authorization?: string; 'Content-Type'?: string } = {};
      if (this.config.james_webadmin_token) {
        headers.Authorization = `Bearer ${this.config.james_webadmin_token}`;
      }

      const getRes = await fetch(identitiesUrl, { method: 'GET', headers });
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
      headers['Content-Type'] = 'application/json';

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

      const updateBody = JSON.stringify(updatePayload);

      const updateRes = await fetch(updateUrl, {
        method: 'PUT',
        headers,
        body: updateBody,
      });

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
   * Get email addresses for a list of member DNs
   * Uses p-limit to parallelize LDAP queries while limiting concurrency
   */
  async getMemberEmails(memberDns: string[]): Promise<string[]> {
    const mailAttr = this.config.mail_attribute || 'mail';

    // Create promises for each member DN, with concurrency limit
    const emailPromises = memberDns
      .filter(memberDn => memberDn !== this.config.group_dummy_user)
      .map(memberDn =>
        this.ldapQueryLimit(async () => {
          try {
            const result = (await this.server.ldap.search(
              { paged: false, scope: 'base', attributes: [mailAttr] },
              memberDn
            )) as SearchResult;

            if (result.searchEntries && result.searchEntries.length > 0) {
              const mail = result.searchEntries[0][mailAttr];
              if (mail) {
                const mailStr = Array.isArray(mail)
                  ? String(mail[0])
                  : String(mail);
                return mailStr;
              }
            }
            return null;
          } catch (err) {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            this.logger.debug(
              `Could not get email for member ${memberDn}: ${err}`
            );
            return null;
          }
        })
      );

    const results = await Promise.all(emailPromises);
    return results.filter((email): email is string => email !== null);
  }

  /**
   * Get the mail address for a group DN
   */
  async getGroupMail(groupDn: string): Promise<string | null> {
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['mail'] },
        groupDn
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        const mail = result.searchEntries[0].mail;
        if (mail) {
          return Array.isArray(mail) ? String(mail[0]) : String(mail);
        }
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`Could not get mail for group ${groupDn}: ${err}`);
    }

    return null;
  }

  async _handleDelegationChange(
    dn: string,
    changes: ChangesToNotify
  ): Promise<void> {
    // Get the user's mail attribute from LDAP (only fetch mail attribute)
    const mailAttr = this.config.mail_attribute || 'mail';
    const entry = (await this.server.ldap.search(
      { paged: false, scope: 'base', attributes: [mailAttr] },
      dn
    )) as SearchResult;
    if (!entry.searchEntries || entry.searchEntries.length !== 1) {
      this.logger.warn({
        plugin: this.name,
        event: 'onLdapChange',
        dn,
        message: 'Could not find user entry to get mail attribute',
      });
      return;
    }

    const userMail = entry.searchEntries[0][mailAttr];
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

    // Process additions and removals in parallel
    const operations: Promise<void>[] = [];

    for (const delegateDN of addedDNs) {
      const delegateEmail = await this._getDelegateEmail(delegateDN);
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

    for (const delegateDN of removedDNs) {
      const delegateEmail = await this._getDelegateEmail(delegateDN);
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
    try {
      const result = (await this.server.ldap.search(
        { paged: false },
        dn
      )) as SearchResult;
      if (result.searchEntries && result.searchEntries.length === 1) {
        const mail = result.searchEntries[0].mail;
        if (mail && typeof mail === 'string') {
          return mail;
        }
      }
    } catch (err) {
      this.logger.warn({
        plugin: this.name,
        event: 'getDelegateEmail',
        dn,
        message: 'Could not resolve delegate DN to email',
        error: err,
      });
    }
    return null;
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
  }
}
