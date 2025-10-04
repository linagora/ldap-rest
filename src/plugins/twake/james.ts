import fetch from 'node-fetch';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { Hooks } from '../../hooks';
import type { ChangesToNotify } from '../ldap/onChange';
import type { AttributeValue, SearchResult } from '../../lib/ldapActions';

export default class James extends DmPlugin {
  name = 'james';
  roles: Role[] = ['consistency'] as const;

  dependencies = { onLdapChange: 'core/ldap/onChange' };

  hooks: Hooks = {
    onLdapMailChange: (dn: string, oldmail: string, newmail: string) => {
      return this._try(
        'onLdapMailChange',
        `${this.config.james_webadmin_url}/users/${oldmail}/rename/${newmail}?action=rename`,
        'POST',
        dn,
        null,
        { oldmail, newmail }
      );
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
    onLdapChange: async (dn: string, changes: ChangesToNotify) => {
      if (
        this.config.delegation_attribute &&
        changes[this.config.delegation_attribute]
      ) {
        await this._handleDelegationChange(dn, changes);
      }
    },
  };

  async _handleDelegationChange(
    dn: string,
    changes: ChangesToNotify
  ): Promise<void> {
    // Get the user's mail attribute from LDAP
    const entry = (await this.server.ldap.search(
      { paged: false },
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

    const userMail = entry.searchEntries[0].mail;
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
    const oldDNs = this._normalizeToArray(oldDelegated);
    const newDNs = this._normalizeToArray(newDelegated);

    // Find added and removed delegations
    const addedDNs = newDNs.filter(delegateDN => !oldDNs.includes(delegateDN));
    const removedDNs = oldDNs.filter(
      delegateDN => !newDNs.includes(delegateDN)
    );

    // Process additions
    for (const delegateDN of addedDNs) {
      const delegateEmail = await this._getDelegateEmail(delegateDN);
      if (delegateEmail) {
        await this._try(
          'onLdapChange:addDelegation',
          `${this.config.james_webadmin_url}/users/${userMail}/authorizedUsers/${delegateEmail}`,
          'PUT',
          dn,
          null,
          { userMail, delegateEmail, delegateDN, action: 'add' }
        );
      }
    }

    // Process removals
    for (const delegateDN of removedDNs) {
      const delegateEmail = await this._getDelegateEmail(delegateDN);
      if (delegateEmail) {
        await this._try(
          'onLdapChange:removeDelegation',
          `${this.config.james_webadmin_url}/users/${userMail}/authorizedUsers/${delegateEmail}`,
          'DELETE',
          dn,
          null,
          { userMail, delegateEmail, delegateDN, action: 'remove' }
        );
      }
    }
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
        this.logger.error({
          ...log,
          http_status: res.status,
          http_status_text: res.statusText,
        });
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
