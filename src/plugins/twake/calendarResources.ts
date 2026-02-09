import TwakePlugin from '../../abstract/twakePlugin';
import { type Role } from '../../abstract/plugin';
import type { AttributesList } from '../../lib/ldapActions';
import { Hooks } from '../../hooks';

/**
 * Plugin to sync LDAP resources with Twake Calendar
 *
 * Monitors a LDAP branch for resources (meeting rooms, equipment, etc.)
 * and automatically creates/updates/deletes them in Twake Calendar via WebAdmin API
 */
export default class CalendarResources extends TwakePlugin {
  name = 'calendarResources';
  roles: Role[] = ['consistency'] as const;

  // Calendar-specific configuration attributes
  private resourceBase: string;
  private resourceObjectClass: string;
  private resourceCreator: string;
  private resourceDomain: string;

  constructor(server: import('../../bin').DM) {
    super(
      server,
      'calendar_webadmin_url',
      'calendar_webadmin_token',
      'calendar_concurrency'
    );

    // Initialize Calendar-specific configuration attributes
    this.resourceBase = (this.config.calendar_resource_base as string) || '';
    this.resourceObjectClass =
      (this.config.calendar_resource_objectclass as string) || '';
    this.resourceCreator =
      (this.config.calendar_resource_creator as string) || 'admin@example.com';
    this.resourceDomain =
      (this.config.calendar_resource_domain as string) || '';
  }

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

      await this.callWebAdminApi(
        'ldapcalendarResourceadddone',
        `${this.webadminUrl}/resources`,
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

      await this.callWebAdminApi(
        'ldapcalendarResourcemodifydone',
        `${this.webadminUrl}/resources/${resourceId}`,
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

      await this.callWebAdminApi(
        'ldapcalendarResourcedeletedone',
        `${this.webadminUrl}/resources/${resourceId}`,
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
    if (
      this.resourceBase &&
      !dn.toLowerCase().includes(this.resourceBase.toLowerCase())
    ) {
      return false;
    }

    // Check for specific objectClass if configured
    const objectClass = attributes.objectClass;
    if (this.resourceObjectClass) {
      const classes = Array.isArray(objectClass) ? objectClass : [objectClass];
      return classes.some(
        cls =>
          String(cls).toLowerCase() === this.resourceObjectClass.toLowerCase()
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
    const name = this.attributeToString(cn);

    if (!name) {
      return null;
    }

    // Extract optional description
    const description =
      this.attributeToString(attributes.description) || undefined;

    // Use configured creator or default
    const creator = this.resourceCreator;

    // Extract domain from DN or use configured domain
    const domain = this.resourceDomain || this.extractDomainFromDn(dn);

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
   * Delete user data from Twake Calendar WebAdmin API
   * @param username - The username to delete data for
   * @returns Task information or null on error
   */
  async deleteUserData(username: string): Promise<{ taskId: string } | null> {
    const log = {
      plugin: this.name,
      event: 'deleteUserData',
      username,
    };

    try {
      const url = new URL(`${this.webadminUrl}/users/${username}`);
      url.searchParams.set('action', 'deleteData');

      const response = await this.requestLimit(() =>
        fetch(url.toString(), {
          method: 'POST',
          headers: this.createHeaders(),
        })
      );

      if (!response.ok) {
        this.logger.error({
          ...log,
          http_status: response.status,
          http_status_text: response.statusText,
        });
        return null;
      }

      const taskInfo = (await response.json()) as { taskId: string };

      this.logger.info({
        ...log,
        http_status: response.status,
        taskId: taskInfo.taskId,
      });

      return taskInfo;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error({ ...log, error: `${err}` });
      return null;
    }
  }
}
