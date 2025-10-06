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
  forward_attribute: 'onLdapForwardChange',
  display_name_attribute: 'onLdapDisplayNameChange',
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
        // Special handling for hooks that need mail parameter
        if (
          hookName === 'onLdapQuotaChange' ||
          hookName === 'onLdapForwardChange' ||
          hookName === 'onLdapAliasChange'
        ) {
          void this.notifyAttributeChangeWithMail(
            this.config[configParam] as string,
            hookName,
            dn,
            changes
          );
        } else if (hookName === 'onLdapMailChange') {
          // Only mail change uses the simple notification
          this.notifyAttributeChange(
            this.config[configParam] as string,
            hookName,
            dn,
            changes
          );
        }
      }
    }
    // Trigger onLdapDisplayNameChange if cn, givenName or sn changed
    if (changes.cn || changes.givenName || changes.sn) {
      // Reconstruct old and new display names from changed attributes
      const oldDisplayName = this.reconstructDisplayName(changes, 0);
      const newDisplayName = this.reconstructDisplayName(changes, 1);
      void launchHooks(
        this.server.hooks.onLdapDisplayNameChange,
        dn,
        oldDisplayName,
        newDisplayName
      );
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

  async notifyAttributeChangeWithMail(
    attribute: string,
    hookName: keyof Hooks,
    dn: string,
    changes: ChangesToNotify
  ): Promise<void> {
    const [oldValue, newValue] = changes[attribute] || [];
    if (oldValue === undefined && newValue === undefined) return;

    // Get current mail address (needed for hooks that require mail parameter)
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
            `Could not find mail for ${dn}, skipping ${hookName} notification`
          );
          return;
        }
      } catch (err) {
        this.logger.error(`Error fetching mail for ${dn}:`, err);
        return;
      }
    }

    // Handle different hook types
    if (hookName === 'onLdapQuotaChange') {
      // Quota change - expects numbers
      const oldQuota = oldValue ? Number(oldValue) : 0;
      const newQuota = newValue ? Number(newValue) : 0;
      if (oldQuota !== newQuota) {
        void launchHooks(
          this.server.hooks[hookName],
          dn,
          mail,
          oldQuota,
          newQuota
        );
      }
    } else if (
      hookName === 'onLdapForwardChange' ||
      hookName === 'onLdapAliasChange'
    ) {
      // Forward/Alias change - expects arrays of strings
      const oldArray = oldValue
        ? Array.isArray(oldValue)
          ? (oldValue as string[])
          : [oldValue as string]
        : [];
      const newArray = newValue
        ? Array.isArray(newValue)
          ? (newValue as string[])
          : [newValue as string]
        : [];

      if (oldArray.length > 0 || newArray.length > 0) {
        void launchHooks(
          this.server.hooks[hookName],
          dn,
          mail,
          oldArray,
          newArray
        );
      }
    }
  }

  /**
   * Reconstruct display name from cn, givenName, and sn attributes
   * @param changes - The changes object
   * @param index - 0 for old value, 1 for new value
   * @returns The reconstructed display name or null
   */
  reconstructDisplayName(
    changes: ChangesToNotify,
    index: 0 | 1
  ): string | null {
    const getValue = (attr: string): string | null => {
      if (!changes[attr]) return null;
      const value = changes[attr][index];
      if (!value) return null;
      if (Array.isArray(value))
        return value.length > 0 ? String(value[0]) : null;
      return String(value);
    };

    // Try cn first
    const cn = getValue('cn');
    if (cn) return cn;

    // Try givenName + sn
    const givenName = getValue('givenName');
    const sn = getValue('sn');
    if (givenName || sn) {
      const parts = [];
      if (givenName) parts.push(givenName);
      if (sn) parts.push(sn);
      return parts.join(' ');
    }

    return null;
  }
}

export default OnLdapChange;
