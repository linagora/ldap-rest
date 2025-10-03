import fetch from 'node-fetch';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { Hooks } from '../../hooks';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';

export default class James extends DmPlugin {
  name = 'james';
  roles: Role[] = ['consistency'] as const;

  dependencies = { onLdapChange: 'core/ldap/onChange' };

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

  hooks: Hooks = {
    ldapadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;
      const mailAttr = this.config.mail_attribute || 'mail';
      const aliasAttr = this.config.alias_attribute || 'mailAlternateAddress';

      const mail = attributes[mailAttr];
      const aliases = attributes[aliasAttr];

      if (!mail || !aliases) {
        // Not a user with mail/aliases, skip
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);
      const aliasList = this.getAliases(aliases);

      if (aliasList.length === 0) return;

      // Wait a bit to ensure James has created the user
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Create all aliases
      for (const alias of aliasList) {
        await this._try(
          'ldapadddone',
          `${this.config.james_webadmin_url}/address/aliases/${mailStr}/sources/${alias}`,
          'PUT',
          dn,
          null,
          { mail: mailStr, alias }
        );
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

      // Delete removed aliases
      for (const alias of toDelete) {
        await this._try(
          'onLdapAliasChange-delete',
          `${this.config.james_webadmin_url}/address/aliases/${mail}/sources/${alias}`,
          'DELETE',
          dn,
          null,
          { mail, alias, action: 'delete' }
        );
      }

      // Add new aliases
      for (const alias of toAdd) {
        await this._try(
          'onLdapAliasChange-add',
          `${this.config.james_webadmin_url}/address/aliases/${mail}/sources/${alias}`,
          'PUT',
          dn,
          null,
          { mail, alias, action: 'add' }
        );
      }
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
  };

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
