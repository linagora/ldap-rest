/**
 * @module core/onLdapChange
 * Check for ldap modify events and generate hooks:
 *  - onLdapChange
 *  - onLdapMailChange
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { Entry } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { Hooks } from '../../hooks';
import type { AttributeValue, SearchResult } from '../../lib/ldapActions';
import { launchHooks } from '../../lib/utils';
import type { Config } from '../../bin';

export type ChangesToNotify = Record<
  string,
  [AttributeValue | null, AttributeValue | null]
>;

const events: {
  [configParam: keyof Config]: keyof Hooks;
} = {
  mail_attribute: 'onLdapMailChange',
  quota_attribute: 'onLdapQuotaChange',
  alias_attribute: 'onLdapAliasChange',
};

class OnLdapChange extends DmPlugin {
  name = 'onLdapChange';
  roles: Role[] = ['consistency'] as const;

  stack: Record<number, Entry> = {};

  hooks: Hooks = {
    ldapmodifyrequest: async ([dn, attributes, op]) => {
      const tmp = (await this.server.ldap.search(
        { paged: false },
        dn
      )) as SearchResult;
      if (tmp.searchEntries.length == 1) {
        this.stack[op] = tmp.searchEntries[0];
      } else {
        this.logger.warn(
          `Could not find unique entry ${dn} before modification, got ${tmp.searchEntries.length} entries`
        );
      }
      return [dn, attributes, op];
    },

    ldapmodifydone: ([dn, changes, op]) => {
      const prev = this.stack[op];
      if (!prev) {
        delete this.stack[op];
        this.logger.warn(
          `Received a ldapmodifydone for an unknown operation (${op})`
        );
        return;
      }
      const res: ChangesToNotify = {};
      if (changes.add) {
        for (const [key, value] of Object.entries(changes.add)) {
          res[key] = [null, value];
        }
      }
      if (changes.delete) {
        if (Array.isArray(changes.delete)) {
          for (const attr of changes.delete) {
            res[attr] = [prev[attr], null];
          }
        } else {
          for (const [key, value] of Object.entries(changes.delete)) {
            res[key] = [value, null];
          }
        }
      }
      if (changes.replace) {
        for (const [key, value] of Object.entries(changes.replace)) {
          res[key] = [prev[key], value];
        }
      }
      this.notify(dn, res);
    },
  };

  notify(dn: string, changes: ChangesToNotify): void {
    void launchHooks(this.server.hooks.onLdapChange, dn, changes);
    for (const [configParam, hookName] of Object.entries(events)) {
      if (
        this.config[configParam] &&
        changes[this.config[configParam] as string]
      ) {
        // Special handling for alias changes - needs mail parameter
        if (hookName === 'onLdapAliasChange') {
          void this.notifyAliasChange(
            this.config[configParam] as string,
            dn,
            changes
          );
        } else {
          this.notifyAttributeChange(
            this.config[configParam] as string,
            hookName,
            dn,
            changes
          );
        }
      }
    }
  }

  notifyAttributeChange(
    attribute: string,
    hookName: keyof Hooks,
    dn: string,
    changes: ChangesToNotify,
    stringOnly: boolean = false
  ): void {
    const [oldValue, newValue] = changes[attribute] || [];
    if (oldValue === undefined && newValue === undefined) return;
    if (stringOnly && (Array.isArray(oldValue) || Array.isArray(newValue))) {
      this.logger.error(
        `Attribute ${attribute} change detected but one of the values is an array, cannot handle that`
      );
      return;
    }
    if (oldValue !== newValue) {
      void launchHooks(this.server.hooks[hookName], dn, oldValue, newValue);
    }
  }

  async notifyAliasChange(
    attribute: string,
    dn: string,
    changes: ChangesToNotify
  ): Promise<void> {
    const [oldValue, newValue] = changes[attribute] || [];
    if (oldValue === undefined && newValue === undefined) return;

    // Get current mail address (needed for James alias API)
    const mailAttr = this.config.mail_attribute || 'mail';
    const mailChange = changes[mailAttr];

    let mail: string;
    if (mailChange) {
      // Mail is changing, use new mail
      mail = Array.isArray(mailChange[1])
        ? String(mailChange[1][0])
        : String(mailChange[1]);
    } else {
      // Mail not changing, fetch from LDAP
      try {
        const result = (await this.server.ldap.search(
          { paged: false, scope: 'base', attributes: [mailAttr] },
          dn
        )) as SearchResult;
        if (result.searchEntries.length === 1) {
          const mailValue = result.searchEntries[0][mailAttr];
          mail = Array.isArray(mailValue)
            ? String(mailValue[0])
            : String(mailValue);
        } else {
          this.logger.warn(
            `Could not find mail for ${dn}, skipping alias notification`
          );
          return;
        }
      } catch (err) {
        this.logger.error(`Error fetching mail for ${dn}:`, err);
        return;
      }
    }

    // Normalize old and new aliases to arrays
    const oldAliases = oldValue
      ? Array.isArray(oldValue)
        ? (oldValue as string[])
        : [oldValue as string]
      : [];
    const newAliases = newValue
      ? Array.isArray(newValue)
        ? (newValue as string[])
        : [newValue as string]
      : [];

    if (oldAliases.length > 0 || newAliases.length > 0) {
      void launchHooks(
        this.server.hooks.onLdapAliasChange,
        dn,
        mail,
        oldAliases,
        newAliases
      );
    }
  }
}

export default OnLdapChange;
