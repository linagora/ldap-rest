/**
 * Twake Drive (Cozy) Plugin
 *
 * Synchronizes LDAP user changes with Cozy/Twake Drive via Admin API.
 * Propagates email address and display name changes.
 *
 * @see https://docs.cozy.io/en/cozy-stack/admin/
 */
import fetch from 'node-fetch';

import TwakePlugin from '../../abstract/twakePlugin';
import { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { AttributeValue } from '../../lib/ldapActions';
import { Hooks } from '../../hooks';

export default class Drive extends TwakePlugin {
  name = 'drive';
  roles: Role[] = ['consistency'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
  };

  // Drive-specific configuration attributes
  private cozyDomainAttr: string;

  constructor(server: DM) {
    super(
      server,
      'twake_drive_webadmin_url',
      'twake_drive_webadmin_token',
      'twake_drive_concurrency'
    );

    // LDAP attribute that stores the Cozy instance domain (e.g., "john.mycozy.cloud")
    this.cozyDomainAttr =
      (this.config.twake_drive_domain_attribute as string) || 'twakeCozyDomain';
  }

  /**
   * Get Cozy domain for a user from LDAP
   * @param dn User's LDAP DN
   * @returns Cozy domain or null if not found
   */
  async getCozyDomain(dn: string): Promise<string | null> {
    const entry = await this.ldapGetAttributes(dn, [this.cozyDomainAttr]);
    return entry ? this.attributeToString(entry[this.cozyDomainAttr]) : null;
  }

  /**
   * Update Cozy instance via Admin API
   * @param hookname Hook name for logging
   * @param cozyDomain Cozy instance domain
   * @param dn User's LDAP DN
   * @param params Query parameters to update
   */
  private async updateCozyInstance(
    hookname: string,
    cozyDomain: string,
    dn: string,
    params: Record<string, string>
  ): Promise<void> {
    // Build URL with query parameters
    const url = new URL(`${this.webadminUrl}/instances/${cozyDomain}`);

    // Always add FromCloudery=true to prevent callback loops
    url.searchParams.set('FromCloudery', 'true');

    // Add update parameters
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return this.requestLimit(async () => {
      const log = {
        plugin: this.name,
        event: hookname,
        result: 'error',
        dn,
        cozyDomain,
        ...params,
      };

      try {
        const res = await fetch(url.toString(), {
          method: 'PATCH',
          headers: this.createHeaders('application/json'),
        });

        if (!res.ok) {
          // 404 is acceptable - instance may not exist yet
          if (res.status === 404) {
            this.logger.debug({
              ...log,
              result: 'ignored',
              http_status: res.status,
              http_status_text: res.statusText,
              message: 'Cozy instance not found (may not be provisioned yet)',
            });
          } else {
            this.logger.error({
              ...log,
              http_status: res.status,
              http_status_text: res.statusText,
              url: url.toString(),
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
          url: url.toString(),
        });
      }
    });
  }

  hooks: Hooks = {
    /**
     * Handle email address changes
     * Updates the Cozy instance's Email parameter
     */
    onLdapMailChange: async (
      dn: string,
      oldmail: AttributeValue | null,
      newmail: AttributeValue | null
    ) => {
      // Convert to strings
      const oldmailStr = oldmail
        ? Array.isArray(oldmail)
          ? String(oldmail[0])
          : String(oldmail)
        : null;
      const newmailStr = newmail
        ? Array.isArray(newmail)
          ? String(newmail[0])
          : String(newmail)
        : null;

      // Skip if oldmail is empty/null (this is an add, not a change)
      if (!oldmailStr) {
        this.logger.debug(
          `Skipping mail change for ${dn}: oldmail is empty (mail attribute was added, not changed)`
        );
        return;
      }

      // Skip if newmail is empty
      if (!newmailStr) {
        this.logger.debug(
          `Skipping mail change for ${dn}: newmail is empty (mail attribute was deleted)`
        );
        return;
      }

      // Get Cozy domain for this user
      const cozyDomain = await this.getCozyDomain(dn);
      if (!cozyDomain) {
        this.logger.debug(
          `Skipping mail change for ${dn}: no Cozy domain attribute (${this.cozyDomainAttr})`
        );
        return;
      }

      // Update Cozy instance email
      await this.updateCozyInstance('onLdapMailChange', cozyDomain, dn, {
        Email: newmailStr,
      });
    },

    /**
     * Handle display name changes
     * Updates the Cozy instance's PublicName parameter
     */
    onLdapDisplayNameChange: async (dn: string) => {
      // Get Cozy domain and display name
      const entry = await this.ldapGetAttributes(dn, [
        this.cozyDomainAttr,
        this.displayNameAttr,
        'cn',
        'givenName',
        'sn',
      ]);

      if (!entry) {
        this.logger.warn(
          `Cannot update Cozy display name: entry not found for ${dn}`
        );
        return;
      }

      const cozyDomain = this.attributeToString(entry[this.cozyDomainAttr]);
      if (!cozyDomain) {
        this.logger.debug(
          `Skipping display name change for ${dn}: no Cozy domain attribute (${this.cozyDomainAttr})`
        );
        return;
      }

      // Get display name with fallback logic
      const displayName = this.getDisplayNameFromAttributes(entry);
      if (!displayName) {
        this.logger.warn(
          `Cannot update Cozy display name: no display name found for ${dn}`
        );
        return;
      }

      // Update Cozy instance public name
      await this.updateCozyInstance('onLdapDisplayNameChange', cozyDomain, dn, {
        PublicName: displayName,
      });
    },
  };

  /**
   * Extract display name from LDAP attributes
   * Fallback logic: displayName → cn → givenName+sn
   */
  private getDisplayNameFromAttributes(
    attributes: import('../../lib/ldapActions').AttributesList
  ): string | null {
    // 1. Try displayName first
    const displayName = this.attributeToString(
      attributes[this.displayNameAttr]
    );
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

    return null;
  }

  /**
   * Public method to get display name from DN
   * Useful for external integrations
   */
  async getDisplayNameFromDN(dn: string): Promise<string | null> {
    const attrs = [this.displayNameAttr, 'cn', 'givenName', 'sn'];
    const entry = await this.ldapGetAttributes(dn, attrs);
    return entry ? this.getDisplayNameFromAttributes(entry) : null;
  }

  /**
   * Public method to get mail from DN
   * Useful for external integrations
   */
  async getMailFromDN(dn: string): Promise<string | null> {
    const entry = await this.ldapGetAttributes(dn, [this.mailAttr]);
    return entry ? this.attributeToString(entry[this.mailAttr]) : null;
  }

  /**
   * Public method to manually sync a user to Cozy
   * Useful for initial sync or manual refresh
   */
  async syncUserToCozy(dn: string): Promise<boolean> {
    const entry = await this.ldapGetAttributes(dn, [
      this.cozyDomainAttr,
      this.mailAttr,
      this.displayNameAttr,
      'cn',
      'givenName',
      'sn',
    ]);

    if (!entry) {
      this.logger.error(`Cannot sync user: entry not found for ${dn}`);
      return false;
    }

    const cozyDomain = this.attributeToString(entry[this.cozyDomainAttr]);
    if (!cozyDomain) {
      this.logger.error(`Cannot sync user: no Cozy domain attribute for ${dn}`);
      return false;
    }

    const mail = this.attributeToString(entry[this.mailAttr]);
    const displayName = this.getDisplayNameFromAttributes(entry);

    const params: Record<string, string> = {};
    if (mail) params.Email = mail;
    if (displayName) params.PublicName = displayName;

    if (Object.keys(params).length === 0) {
      this.logger.warn(`No attributes to sync for ${dn}`);
      return false;
    }

    await this.updateCozyInstance('syncUserToCozy', cozyDomain, dn, params);
    return true;
  }

  /**
   * Block a Cozy instance
   * @param dn User's LDAP DN
   * @param reason Optional blocking reason (e.g., 'PAYMENT_FAILED', 'LOGIN_FAILED', 'SUSPENDED')
   * @returns true if successful, false otherwise
   */
  async blockInstance(dn: string, reason?: string): Promise<boolean> {
    const cozyDomain = await this.getCozyDomain(dn);
    if (!cozyDomain) {
      this.logger.error(`Cannot block instance: no Cozy domain for ${dn}`);
      return false;
    }

    const params: Record<string, string> = { Blocked: 'true' };
    if (reason) {
      params.BlockingReason = reason;
    }

    await this.updateCozyInstance('blockInstance', cozyDomain, dn, params);
    return true;
  }

  /**
   * Unblock a Cozy instance
   * @param dn User's LDAP DN
   * @returns true if successful, false otherwise
   */
  async unblockInstance(dn: string): Promise<boolean> {
    const cozyDomain = await this.getCozyDomain(dn);
    if (!cozyDomain) {
      this.logger.error(`Cannot unblock instance: no Cozy domain for ${dn}`);
      return false;
    }

    await this.updateCozyInstance('unblockInstance', cozyDomain, dn, {
      Blocked: 'false',
    });
    return true;
  }
}
