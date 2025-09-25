/**
 * @plugin core/onLdapChange
 * @description Check for ldap modify events and generate hooks:
 *  - onLdapChange
 *  - onLdapMailChange
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { Entry } from 'ldapts';

import DmPlugin from '../../abstract/plugin';
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
};

class OnLdapChange extends DmPlugin {
  name = 'onLdapChange';

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
}

export default OnLdapChange;
