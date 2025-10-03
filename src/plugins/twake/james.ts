import fetch from 'node-fetch';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { Hooks } from '../../hooks';
import type { AttributesList } from '../../lib/ldapActions';

export default class James extends DmPlugin {
  name = 'james';
  roles: Role[] = ['consistency'] as const;

  dependencies = { onLdapChange: 'core/ldap/onChange' };

  hooks: Hooks = {
    ldapadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;
      // Initialize quota when user is created
      const mailAttr = this.config.mail_attribute || 'mail';
      const quotaAttr = this.config.quota_attribute || 'mailQuota';

      const mail = attributes[mailAttr];
      const quota = attributes[quotaAttr];

      if (!mail || !quota) {
        // Not a user with mail/quota, skip
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);
      // Handle both string and number values (LDAP stores as string, but accepts both)
      const quotaNum = Array.isArray(quota) ? Number(quota[0]) : Number(quota);

      if (isNaN(quotaNum) || quotaNum <= 0) {
        // Invalid quota, skip
        return;
      }

      // Wait a bit to ensure James has created the user
      await new Promise(resolve => setTimeout(resolve, 1000));

      return this._try(
        'ldapadddone',
        `${this.config.james_webadmin_url}/quota/users/${mailStr}/size`,
        'PUT',
        dn,
        quotaNum.toString(),
        { mail: mailStr, quota: quotaNum }
      );
    },
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
