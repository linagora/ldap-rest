import fetch from 'node-fetch';

import TwakePlugin from '../../abstract/twakePlugin';
import { type Role } from '../../abstract/plugin';
import type { AttributesList, AttributeValue } from '../../lib/ldapActions';
import { Hooks } from '../../hooks';

/**
 * Plugin to sync LDAP resources and users with Twake Calendar
 *
 * Monitors a LDAP branch for resources (meeting rooms, equipment, etc.)
 * and automatically creates/updates/deletes them in Twake Calendar via WebAdmin API.
 *
 * Also propagates user identity changes (email, first name, last name) to the
 * Twake Calendar "registered users" via the WebAdmin API.
 */
export default class CalendarResources extends TwakePlugin {
  name = 'calendarResources';
  roles: Role[] = ['consistency'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
  };

  // Calendar-specific configuration attributes
  private resourceBase: string;
  private resourceObjectClass: string;
  private resourceCreator: string;
  private resourceDomain: string;
  private firstnameAttr: string;
  private lastnameAttr: string;

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

    // LDAP attributes holding the user's first and last name (for registered users)
    this.firstnameAttr =
      (this.config.calendar_firstname_attribute as string) || 'givenName';
    this.lastnameAttr =
      (this.config.calendar_lastname_attribute as string) || 'sn';
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

    /**
     * Handle user email changes.
     * The registered user is keyed by the (old) email in Calendar, so we look
     * it up by the old address and PATCH it with the new email and names.
     */
    onLdapMailChange: async (
      dn: string,
      oldmail: AttributeValue | null,
      newmail: AttributeValue | null
    ) => {
      const oldmailStr = this.attributeToString(oldmail);
      const newmailStr = this.attributeToString(newmail);

      // Skip additions (no previous mail) and deletions (no new mail):
      // there is nothing to update on the Calendar side in those cases.
      if (!oldmailStr) {
        this.logger.debug(
          `Skipping registered user sync for ${dn}: oldmail is empty (mail added, not changed)`
        );
        return;
      }
      if (!newmailStr) {
        this.logger.debug(
          `Skipping registered user sync for ${dn}: newmail is empty (mail deleted)`
        );
        return;
      }

      await this.syncRegisteredUser('onLdapMailChange', dn, oldmailStr);
    },

    /**
     * Handle display name changes (cn / givenName / sn).
     * The email is unchanged, so the registered user is looked up by its
     * current mail.
     */
    onLdapDisplayNameChange: async (dn: string) => {
      await this.syncRegisteredUser('onLdapDisplayNameChange', dn);
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
   * Synchronize an LDAP user's identity (email, first and last name) to the
   * Twake Calendar registered users via the WebAdmin API.
   *
   * Registered users are keyed by an internal id, and `GET /registeredUsers`
   * exposes no filter, so we list all registered users, locate the entry by
   * email, then `PATCH /registeredUsers?id={id}` with the LDAP values.
   *
   * @param event Hook name, used for logging
   * @param dn LDAP DN of the user
   * @param lookupEmail Email used to locate the existing registered user.
   *   Defaults to the user's current mail; pass the OLD mail when the email
   *   itself is changing (Calendar still holds the previous address).
   */
  async syncRegisteredUser(
    event: string,
    dn: string,
    lookupEmail?: string
  ): Promise<void> {
    const log = {
      plugin: this.name,
      event,
      result: 'error',
      dn,
    };

    // Fetch the desired identity values from LDAP
    const entry = await this.ldapGetAttributes(dn, [
      this.mailAttr,
      this.firstnameAttr,
      this.lastnameAttr,
    ]);
    if (!entry) {
      this.logger.warn({
        ...log,
        message: `Cannot sync registered user: entry not found for ${dn}`,
      });
      return;
    }

    const mail = this.attributeToString(entry[this.mailAttr]);
    if (!mail) {
      this.logger.warn({
        ...log,
        message: `Cannot sync registered user: no mail found for ${dn}`,
      });
      return;
    }

    const firstname = this.attributeToString(entry[this.firstnameAttr]);
    const lastname = this.attributeToString(entry[this.lastnameAttr]);
    const searchEmail = lookupEmail || mail;

    try {
      // Step 1: list registered users and find the one matching searchEmail
      const listRes = await this.requestLimit(() =>
        fetch(`${this.webadminUrl}/registeredUsers`, {
          method: 'GET',
          headers: this.createHeaders(),
        })
      );
      if (!listRes.ok) {
        this.logger.error({
          ...log,
          step: 'list_registered_users',
          http_status: listRes.status,
          http_status_text: listRes.statusText,
        });
        return;
      }

      const users = (await listRes.json()) as Array<{
        id: string;
        email: string;
        firstname?: string;
        lastname?: string;
      }>;
      const existing = users.find(
        u => u.email?.toLowerCase() === searchEmail.toLowerCase()
      );
      if (!existing) {
        this.logger.warn({
          ...log,
          step: 'find_registered_user',
          searchEmail,
          message: 'user not registered in Calendar',
        });
        return;
      }

      // Step 2: PATCH the registered user by id with the LDAP values
      const patchUrl = new URL(`${this.webadminUrl}/registeredUsers`);
      patchUrl.searchParams.set('id', existing.id);

      const payload: {
        email: string;
        firstname?: string;
        lastname?: string;
      } = { email: mail };
      if (firstname) payload.firstname = firstname;
      if (lastname) payload.lastname = lastname;

      const patchRes = await this.requestLimit(() =>
        fetch(patchUrl.toString(), {
          method: 'PATCH',
          headers: this.createHeaders('application/json'),
          body: JSON.stringify(payload),
        })
      );

      if (!patchRes.ok) {
        this.logger.error({
          ...log,
          step: 'patch_registered_user',
          id: existing.id,
          http_status: patchRes.status,
          http_status_text: patchRes.statusText,
        });
      } else {
        this.logger.info({
          ...log,
          result: 'success',
          id: existing.id,
          http_status: patchRes.status,
          ...payload,
        });
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.error({ ...log, error: `${err}` });
    }
  }

  /**
   * Delete user data from Twake Calendar WebAdmin API
   * Calls POST /users/{mail}?action=deleteData
   * @param mail - The user's email address
   * @returns Task information or null on error
   */
  async deleteUserData(mail: string): Promise<{ taskId: string } | null> {
    const log = {
      plugin: this.name,
      event: 'deleteUserData',
      mail,
    };

    try {
      const url = new URL(`${this.webadminUrl}/users/${mail}`);
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
