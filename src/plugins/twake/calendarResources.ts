import fetch from 'node-fetch';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { AttributesList } from '../../lib/ldapActions';
import { Hooks } from '../../hooks';

/**
 * Plugin to sync LDAP resources with Twake Calendar
 *
 * Monitors a LDAP branch for resources (meeting rooms, equipment, etc.)
 * and automatically creates/updates/deletes them in Twake Calendar via WebAdmin API
 */
export default class CalendarResources extends DmPlugin {
  name = 'calendarResources';
  roles: Role[] = ['consistency'] as const;

  hooks: Hooks = {
    // Hook when a resource is added to LDAP
    ldapcalendarResourceadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;

      // Only process resources (identified by objectClass or specific branch)
      if (!this.isResource(dn, attributes)) {
        return;
      }

      const resourceData = this.buildResourceData(dn, attributes);
      if (!resourceData) {
        this.logger.debug(
          `Skipping resource creation for ${dn}: missing required fields`
        );
        return;
      }

      await this._callApi(
        'ldapcalendarResourceadddone',
        `${this.config.calendar_webadmin_url as string}/resources`,
        'POST',
        dn,
        JSON.stringify(resourceData),
        { resourceName: resourceData.name }
      );
    },

    // Hook when a resource is modified in LDAP
    ldapcalendarResourcemodifydone: async (
      args: [
        string,
        {
          add?: AttributesList;
          replace?: AttributesList;
          delete?: string[] | AttributesList;
        },
        number,
      ]
    ) => {
      const [dn, changes] = args;

      // Check if this is a resource
      // TODO: fetch objectClass if needed to verify
      const resourceId = this.getResourceId(dn);
      if (!resourceId) {
        return;
      }

      // Build update payload from changes
      const updateData: Partial<{
        name: string;
        description: string;
      }> = {};

      if (changes.replace?.cn) {
        updateData.name = Array.isArray(changes.replace.cn)
          ? String(changes.replace.cn[0])
          : String(changes.replace.cn);
      }

      if (changes.replace?.description) {
        updateData.description = Array.isArray(changes.replace.description)
          ? String(changes.replace.description[0])
          : String(changes.replace.description);
      }

      if (Object.keys(updateData).length === 0) {
        this.logger.debug(`No relevant changes for resource ${dn}`);
        return;
      }

      await this._callApi(
        'ldapcalendarResourcemodifydone',
        `${this.config.calendar_webadmin_url as string}/resources/${resourceId}`,
        'PATCH',
        dn,
        JSON.stringify(updateData),
        { resourceId, ...updateData }
      );
    },

    // Hook when a resource is deleted from LDAP
    ldapcalendarResourcedeletedone: async (dn: string) => {
      const resourceId = this.getResourceId(dn);
      if (!resourceId) {
        return;
      }

      await this._callApi(
        'ldapcalendarResourcedeletedone',
        `${this.config.calendar_webadmin_url as string}/resources/${resourceId}`,
        'DELETE',
        dn,
        null,
        { resourceId }
      );
    },
  };

  /**
   * Check if a LDAP entry is a calendar resource
   */
  private isResource(dn: string, attributes: AttributesList): boolean {
    // Check if DN is under the resources branch
    const resourceBase = this.config.calendar_resource_base;
    if (
      resourceBase &&
      !dn.toLowerCase().includes(resourceBase.toLowerCase())
    ) {
      return false;
    }

    // Check for specific objectClass if configured
    const objectClass = attributes.objectClass;
    if (this.config.calendar_resource_objectclass) {
      const classes = Array.isArray(objectClass) ? objectClass : [objectClass];
      return classes.some(
        cls =>
          String(cls).toLowerCase() ===
          (this.config.calendar_resource_objectclass as string).toLowerCase()
      );
    }

    return true;
  }

  /**
   * Build resource data for Calendar API from LDAP attributes
   */
  private buildResourceData(
    dn: string,
    attributes: AttributesList
  ): {
    name: string;
    description?: string;
    creator: string;
    domain: string;
    id: string;
  } | null {
    // Extract required fields
    const cn = attributes.cn;
    const name = Array.isArray(cn) ? String(cn[0]) : String(cn);

    if (!name) {
      return null;
    }

    // Extract optional description
    const desc = attributes.description;
    const description = desc
      ? Array.isArray(desc)
        ? String(desc[0])
        : String(desc)
      : undefined;

    // Use configured creator or default
    const creator =
      this.config.calendar_resource_creator || 'admin@example.com';

    // Extract domain from DN or use configured domain
    const domain =
      this.config.calendar_resource_domain || this.extractDomain(dn);

    // Generate ID from DN (use cn or uid)
    const id =
      this.getResourceId(dn) || name.toLowerCase().replace(/\s+/g, '-');

    return {
      name,
      description,
      creator,
      domain,
      id,
    };
  }

  /**
   * Extract resource ID from DN
   */
  private getResourceId(dn: string): string | null {
    // Extract cn or uid from DN
    const match = dn.match(/(?:cn|uid)=([^,]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Extract domain from DN
   */
  private extractDomain(dn: string): string {
    // Extract dc components and join them
    const dcMatches = dn.match(/dc=([^,]+)/gi);
    if (dcMatches) {
      return dcMatches.map(dc => dc.substring(3)).join('.');
    }
    return 'example.com';
  }

  /**
   * Call Twake Calendar WebAdmin API
   */
  async _callApi(
    hookname: string,
    url: string,
    method: string,
    dn: string,
    body: string | null,
    fields: object
  ): Promise<void> {
    const log = {
      plugin: this.name,
      event: hookname,
      result: 'error',
      dn,
      ...fields,
    };

    try {
      const opts: {
        method: string;
        body?: string | null;
        headers: {
          'Content-Type'?: string;
          Authorization?: string;
        };
      } = {
        method,
        headers: {},
      };

      if (body) {
        opts.body = body;
        opts.headers['Content-Type'] = 'application/json';
      }

      if (this.config.calendar_webadmin_token) {
        opts.headers.Authorization = `Bearer ${this.config.calendar_webadmin_token}`;
      }

      const res = await fetch(url, opts);

      if (!res.ok) {
        this.logger.error({
          ...log,
          http_status: res.status,
          http_status_text: res.statusText,
          url,
        });
      } else {
        this.logger.info({
          ...log,
          result: 'success',
          http_status: res.status,
          url,
        });
      }
    } catch (err) {
      this.logger.error({
        ...log,
        error: err,
        url,
      });
    }
  }
}
