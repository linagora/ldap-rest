/**
 * @module core/onLdapChange
 * Publish the state of an entry before and after each write
 * (onLdapEntryChange), and the hooks derived from it: onLdapChange,
 * onLdapMailChange…
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import { Entry } from 'ldapts';
import type { Request } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { Hooks } from '../../hooks';
import type { AttributeValue, SearchResult } from '../../lib/ldapActions';
import { launchHooks } from '../../lib/utils';
import type { Config } from '../../bin';
import type { ChangeContext } from '../../lib/changeContext';
import { currentOperation } from '../../lib/operation';

export type ChangesToNotify = Record<
  string,
  [AttributeValue | null, AttributeValue | null]
>;

const normalize = (value: AttributeValue | undefined): string[] =>
  (value === undefined ? [] : Array.isArray(value) ? value : [value])
    .map(v => (Buffer.isBuffer(v) ? v.toString('base64') : String(v)))
    .sort();

/**
 * The attributes whose values differ between two states of an entry. Values
 * are compared as sets, so a single value and a one-element array are equal,
 * and so are two orderings of the same values.
 */
export function diffEntries(
  before: Entry | null,
  after: Entry | null
): ChangesToNotify {
  // Attribute names are case-insensitive in LDAP
  const index = (entry: Entry | null): Map<string, string> =>
    new Map(
      Object.keys(entry || {})
        .filter(k => k !== 'dn')
        .map(k => [k.toLowerCase(), k])
    );
  const b = index(before);
  const a = index(after);
  const res: ChangesToNotify = {};
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    const bKey = b.get(name);
    const aKey = a.get(name);
    const bVal = bKey ? before![bKey] : undefined;
    const aVal = aKey ? after![aKey] : undefined;
    const bNorm = normalize(bVal);
    const aNorm = normalize(aVal);
    if (
      bNorm.length === aNorm.length &&
      bNorm.every((v, i) => v === aNorm[i])
    ) {
      continue;
    }
    res[(aKey || bKey)!] = [
      bNorm.length ? bVal! : null,
      aNorm.length ? aVal! : null,
    ];
  }
  return res;
}

const events: {
  [configParam: keyof Config]: keyof Hooks;
} = {
  mail_attribute: 'onLdapMailChange',
  quota_attribute: 'onLdapQuotaChange',
  alias_attribute: 'onLdapAliasChange',
  forward_attribute: 'onLdapForwardChange',
  display_name_attribute: 'onLdapDisplayNameChange',
  drive_quota_attribute: 'onLdapDriveQuotaChange',
};

class OnLdapChange extends DmPlugin {
  name = 'onLdapChange';
  roles: Role[] = ['consistency'] as const;

  // The entries read before a write, keyed by its operation number, each
  // kept until the "end" hook of that operation, which fires whatever became
  // of it: a write refused, failed, or taken out of its request by another
  // plugin (trash, tombstone) never reaches its "done" hook. Keyed by DN
  // instead, a refused delete could not tell its own entry from that of
  // another delete of the same DN under way.
  stack: Record<number, Entry> = {};
  pendingDeletions: Map<number, Map<string, Entry>> = new Map();
  pendingRenames: Map<number, { dn: string; entry: Entry }> = new Map();

  hooks: Hooks = {
    ldapadddone: async ([dn, attributes], context) => {
      const after = (await this.read(dn)) || { dn, ...attributes };
      this.publish(dn, null, after, context);
    },

    // The request travels with the tuple: `launchHooksChained` feeds each
    // hook's return value to the next, so dropping it here would blind every
    // authorization plugin registered after this one.
    ldapmodifyrequest: async ([dn, attributes, op, req]) => {
      const entry = await this.read(dn);
      if (entry) {
        this.stack[op] = entry;
      } else {
        this.logger.warn(`Could not read ${dn} before modification`);
      }
      return [dn, attributes, op, req];
    },

    ldapmodifydone: async ([dn, changes, op], context) => {
      const before = this.stack[op];
      delete this.stack[op];
      if (!before) {
        this.logger.warn(
          `Received a ldapmodifydone for an unknown operation (${op})`
        );
        return;
      }
      if (Object.keys(changes).length === 0) return;
      const after = await this.read(dn);
      if (!after) {
        this.logger.warn(`Could not read ${dn} after modification`);
        return;
      }
      this.publish(dn, before, after, context);
    },

    ldapmodifyend: op => {
      delete this.stack[op];
    },

    ldaprenamerequest: async ([dn, newDn, req]) => {
      const op = currentOperation();
      const entry = op === undefined ? undefined : await this.read(dn);
      if (op !== undefined && entry) this.pendingRenames.set(op, { dn, entry });
      return [dn, newDn, req];
    },

    ldaprenamedone: async ([dn, newDn], context) => {
      const op = currentOperation();
      const pending =
        op === undefined ? undefined : this.pendingRenames.get(op);
      if (!pending || pending.dn !== dn) {
        // A move reaches this hook too (`ldapActions.move` is a modifyDN), and
        // it launches no `ldaprenamerequest` — that is an authorization hook,
        // and the write that drove the move was already judged. So there is no
        // snapshot: an entry moved to the trash, not a fault. It is the
        // ordinary path here, and warning would add a line per trashed entry.
        this.logger.debug(`${dn}: no snapshot: a move made outside a request`);
        return;
      }
      this.pendingRenames.delete(op!);
      const after = await this.read(newDn);
      if (!after) {
        this.logger.warn(`Could not read ${newDn} after the rename of ${dn}`);
        return;
      }
      this.publish(newDn, pending.entry, after, context);
    },

    ldaprenameend: op => {
      this.pendingRenames.delete(op);
    },

    ldapdeleterequest: async ([dn, req]: [string | string[], Request?]) => {
      const op = currentOperation();
      if (op === undefined) return [dn, req] as [string | string[], Request?];
      for (const target of Array.isArray(dn) ? dn : [dn]) {
        const entry = await this.read(target);
        if (!entry) continue;
        let kept = this.pendingDeletions.get(op);
        if (!kept)
          this.pendingDeletions.set(op, (kept = new Map<string, Entry>()));
        kept.set(target, entry);
      }
      return [dn, req] as [string | string[], Request?];
    },

    ldapdeletedone: (dn: string | string[], context?: ChangeContext) => {
      const op = currentOperation();
      const kept = op === undefined ? undefined : this.pendingDeletions.get(op);
      for (const target of Array.isArray(dn) ? dn : [dn]) {
        const before = kept?.get(target);
        if (!before) continue;
        kept!.delete(target);
        this.publish(target, before, null, context);
      }
    },

    ldapdeleteend: op => {
      this.pendingDeletions.delete(op);
    },
  };

  async read(dn: string): Promise<Entry | undefined> {
    const followed = new Set(
      Object.values(this.server.loadedPlugins).flatMap(
        p => p.followedOperationalAttributes || []
      )
    );
    try {
      const res = (await this.server.ldap.search(
        {
          paged: false,
          scope: 'base',
          ...(followed.size ? { attributes: ['*', ...followed] } : {}),
        },
        dn
      )) as SearchResult;
      const entry = res.searchEntries[0];
      if (!entry) return undefined;
      // ldapts lists every attribute requested, `*` included, with an empty
      // array for those the entry does not hold
      return Object.fromEntries(
        Object.entries(entry).filter(
          ([, v]) => !Array.isArray(v) || v.length > 0
        )
      ) as Entry;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      return undefined;
    }
  }

  publish(
    dn: string,
    before: Entry | null,
    after: Entry | null,
    context: ChangeContext = {}
  ): void {
    const changes = diffEntries(before, after);
    if (Object.keys(changes).length === 0 && before?.dn === after?.dn) return;
    void launchHooks(
      this.server.hooks.onLdapEntryChange,
      dn,
      before,
      after,
      context
    );
    this.notify(dn, changes, before, after);
  }

  notify(
    dn: string,
    changes: ChangesToNotify,
    before: Entry | null,
    after: Entry | null
  ): void {
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
          this.notifyAttributeChangeWithMail(
            this.config[configParam] as string,
            hookName,
            dn,
            changes,
            after
          );
        } else if (hookName === 'onLdapMailChange') {
          // Only mail change uses the simple notification
          this.notifyAttributeChange(
            this.config[configParam] as string,
            hookName,
            dn,
            changes
          );
        } else if (hookName === 'onLdapDriveQuotaChange') {
          // Drive quota change - expects numbers, no mail needed
          const [oldValue, newValue] =
            changes[this.config[configParam] as string] || [];
          const oldQuota = oldValue ? Number(oldValue) : null;
          const newQuota = newValue ? Number(newValue) : null;
          if (oldQuota !== newQuota) {
            void launchHooks(
              this.server.hooks.onLdapDriveQuotaChange,
              dn,
              oldQuota,
              newQuota
            );
          }
        }
      }
    }
    const oldDisplayName = this.reconstructDisplayName(before);
    const newDisplayName = this.reconstructDisplayName(after);
    if (oldDisplayName !== newDisplayName) {
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

  notifyAttributeChangeWithMail(
    attribute: string,
    hookName: keyof Hooks,
    dn: string,
    changes: ChangesToNotify,
    after: Entry | null
  ): void {
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
    } else if (after?.[mailAttr]) {
      const mailValue = after[mailAttr];
      mail = Array.isArray(mailValue)
        ? String(mailValue[0])
        : String(mailValue);
    } else {
      this.logger.warn(
        `Could not find mail for ${dn}, skipping ${hookName} notification`
      );
      return;
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
   * The name the James plugin gives an identity, in the same order: the
   * display name attribute, then cn, then givenName + sn
   * (`getDisplayNameFromAttributes` in plugins/twake/james.ts). Reading cn
   * first, as this did, missed a change of displayName alone, the attribute
   * the console and the schemas edit. The James plugin's last resort, the
   * mail, is left out: a mail change already has its own hook, and an entry
   * without any name would turn every mail change into a name change.
   * @param entry - The entry, before or after the change
   * @returns The display name or null
   */
  reconstructDisplayName(entry: Entry | null): string | null {
    const getValue = (attr: string): string | null => {
      if (!entry) return null;
      // Attribute names are case-insensitive, and the server answers them
      // as its schema spells them
      const key = Object.keys(entry).find(
        k => k.toLowerCase() === attr.toLowerCase()
      );
      const value = key === undefined ? undefined : entry[key];
      if (!value) return null;
      if (Array.isArray(value))
        return value.length > 0 ? String(value[0]) : null;
      return String(value);
    };

    const displayName = getValue(
      (this.config.display_name_attribute as string) || 'displayName'
    );
    if (displayName) return displayName;

    const cn = getValue('cn');
    if (cn) return cn;

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
