import fetch from 'node-fetch';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { Hooks } from '../../hooks';

export default class James extends DmPlugin {
  name = 'james';
  roles: Role[] = ['consistency'] as const;

  dependencies = { onLdapChange: 'core/ldap/onChange' };

  hooks: Hooks = {
    ldapadddone: async (args) => {
      const [dn, attributes] = args;
      // Initialize James identity when user is created
      const mail = await this.getMailFromDN(dn);
      if (!mail) {
        // Not a user entry or no mail attribute, skip
        return;
      }

      const displayName = await this.getDisplayNameFromDN(dn);
      if (!displayName) {
        this.logger.warn(
          `Cannot initialize James identity: no display name found for ${dn}`
        );
        return;
      }

      // Wait a bit to ensure James has created the user
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Update James identity via JMAP
      return this.updateJamesIdentity(dn, mail, displayName);
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
    onLdapDisplayNameChange: async (
      dn: string,
      oldDisplayName: string | null,
      newDisplayName: string | null
    ) => {
      // Get mail address from DN
      const mail = await this.getMailFromDN(dn);
      if (!mail) {
        this.logger.warn(
          `Cannot update James identity: no mail found for ${dn}`
        );
        return;
      }

      // Get display name with fallback logic
      const displayName = await this.getDisplayNameFromDN(dn);
      if (!displayName) {
        this.logger.warn(
          `Cannot update James identity: no display name found for ${dn}`
        );
        return;
      }

      // Update James identity via JMAP
      return this.updateJamesIdentity(dn, mail, displayName);
    },
  };

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
        const entry = result.searchEntries[0];
        const displayNameAttr =
          this.config.display_name_attribute || 'displayName';

        // Helper to convert LDAP attribute value to string
        const toString = (value: unknown): string | null => {
          if (!value) return null;
          if (Array.isArray(value)) {
            return value.length > 0 ? String(value[0]) : null;
          }
          return String(value);
        };

        // 1. Try displayName first
        const displayName = toString(entry[displayNameAttr]);
        if (displayName) return displayName;

        // 2. Try cn
        const cn = toString(entry.cn);
        if (cn) return cn;

        // 3. Try givenName + sn
        const givenName = toString(entry.givenName);
        const sn = toString(entry.sn);
        if (givenName || sn) {
          const parts = [];
          if (givenName) parts.push(givenName);
          if (sn) parts.push(sn);
          return parts.join(' ');
        }

        // 4. Fallback to mail
        const mailAttr = this.config.mail_attribute || 'mail';
        const mail = toString(entry[mailAttr]);
        if (mail) return mail;
      }
    } catch (err) {
      this.logger.error(`Failed to get display name from DN ${dn}: ${err}`);
    }
    return null;
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

      // Step 3: Update identity name
      const updateUrl = `${this.config.james_webadmin_url}/jmap/identities/${mail}/${defaultIdentity.id}`;
      headers['Content-Type'] = 'application/json';

      const updateBody = JSON.stringify({
        id: defaultIdentity.id,
        email: defaultIdentity.email,
        name: displayName,
      });

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
      this.logger.error({
        ...log,
        error: err,
      });
    }
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
