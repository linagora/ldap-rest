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
        this.notifyAttributeChange(
          this.config[configParam] as string,
          hookName,
          dn,
          changes
        );
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
