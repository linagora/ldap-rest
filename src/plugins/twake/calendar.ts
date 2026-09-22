import fetch from 'node-fetch';

import TwakePlugin from '../../abstract/twakePlugin';
import { type Role } from '../../abstract/plugin';
import type { AttributesList } from '../../lib/ldapActions';
import type { ChangesToNotify } from '../ldap/onChange';
import { Hooks } from '../../hooks';
import { isDnInBranch, rdnValue } from '../../lib/utils';

/** A Twake Calendar registered user, as the WebAdmin API returns it */
interface RegisteredUser {
  id: string;
  email: string;
  firstname?: string;
  lastname?: string;
}

function isRegisteredUser(value: unknown): value is RegisteredUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/**
 * Plugin to sync LDAP resources and users with Twake Calendar
 *
 * Monitors a LDAP branch for resources (meeting rooms, equipment, etc.)
 * and automatically creates/updates/deletes them in Twake Calendar via WebAdmin API.
 *
 * Also propagates user identity changes (email, first name, last name) to the
 * Twake Calendar "registered users" via the WebAdmin API.
 */
export default class Calendar extends TwakePlugin {
  name = 'calendar';
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

    // The resource base is compared to an entry's DN part by part, so it has
    // to be a full DN: `ou=resources` alone names no branch and would leave
    // every resource unsynchronised without a word. Say so at startup rather
    // than let the deployment wonder why nothing reaches Calendar.
    const ldapBase = this.config.ldap_base;
    if (
      this.resourceBase &&
      ldapBase &&
      !isDnInBranch(this.resourceBase, ldapBase)
    ) {
      this.logger.warn(
        `Calendar plugin: calendar_resource_base (${this.resourceBase}) is not a DN under ${ldapBase}; no entry will be taken for a resource`
      );
    }

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

      // Same branch guard as the add hook, and the branch alone: a modify
      // carries the attributes that changed, so an untouched objectClass is
      // simply not there to compare against calendar_resource_objectclass.
      // That is enough here — the hook only fires for the calendarResource
      // entity, whose objectClass its schema fixes, so the branch is what
      // still tells a resource from an entry of the same entity rooted
      // elsewhere. Without it, modifying such an entry patched the Calendar
      // resource carrying the same id.
      if (!this.isInResourceBranch(dn)) {
        return;
      }

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
        this.resourceUrl(resourceId),
        'PATCH',
        dn,
        JSON.stringify(updateData),
        { resourceId, ...updateData }
      );
    },

    // Hook when a resource is deleted from LDAP
    ldapcalendarResourcedeletedone: async (dn: string) => {
      // The entry is already gone when this runs, so there is no objectClass
      // left to read: the branch is the whole guard, as on the modify path.
      // Reading the entry before it goes would mean a lookup on the chained
      // `ldapcalendarResourcedelete` hook plus state carried from there to
      // here, keyed by DN only — the delete path has no operation number to
      // key it on, unlike modify — for a filter the entity's fixed
      // objectClass makes moot. Not worth the machinery; the branch is the
      // test that discriminates.
      if (!this.isInResourceBranch(dn)) {
        return;
      }

      const resourceId = this.getResourceId(dn);
      if (!resourceId) {
        return;
      }

      await this.callWebAdminApi(
        'ldapcalendarResourcedeletedone',
        this.resourceUrl(resourceId),
        'DELETE',
        dn,
        null,
        { resourceId }
      );
    },

    /**
     * Propagate user identity changes to the Calendar registered users.
     *
     * A single hook is used (rather than onLdapMailChange /
     * onLdapDisplayNameChange) so the sync is driven by the *configured* mail,
     * first name and last name attributes — the display-name hook only fires on
     * the hard-coded cn/givenName/sn attributes, which would silently ignore a
     * non-default firstname/lastname attribute.
     */
    onLdapChange: async (dn: string, changes: ChangesToNotify) => {
      const mailChange = changes[this.mailAttr];
      if (mailChange) {
        const oldmail = this.attributeToString(mailChange[0]);
        const newmail = this.attributeToString(mailChange[1]);

        // Only a real rename (old and new both present) updates Calendar.
        // Additions and deletions of the mail attribute are skipped: there is
        // nothing to rename on the Calendar side.
        if (oldmail && newmail && oldmail !== newmail) {
          // The registered user is keyed by the previous email in Calendar, so
          // look it up by the old address and PATCH it with the new values.
          await this.syncRegisteredUser('onLdapMailChange', dn, oldmail);
        }
        return;
      }

      // Name-only change: sync when a configured name attribute changed. The
      // email is unchanged, so the user is looked up by its current mail.
      if (changes[this.firstnameAttr] || changes[this.lastnameAttr]) {
        await this.syncRegisteredUser('onLdapDisplayNameChange', dn);
      }
    },
  };

  /**
   * Check if a LDAP entry is a calendar resource
   */
  private isResource(dn: string, attributes: AttributesList): boolean {
    // Check if DN is under the resources branch
    if (!this.isInResourceBranch(dn)) {
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
   * Whether a DN is the configured resource branch or sits below it.
   *
   * Compared RDN by RDN ({@link isDnInBranch}), not as text: a substring test
   * took `cn=Salle,ou=resourcesArchive,…` for a resource when the branch was
   * given as `ou=resources`, and missed a DN written `cn=Salle, ou=resources,
   * …` — the spaces a client puts after its commas are not part of the DN.
   *
   * No configured branch means no branch restriction, as before.
   */
  private isInResourceBranch(dn: string): boolean {
    return !this.resourceBase || isDnInBranch(dn, this.resourceBase);
  }

  /**
   * URL of one resource in the WebAdmin API.
   *
   * The id is a raw RDN value, so it can carry anything a directory accepts:
   * `cn=Salle A/B` interpolated as such builds `/resources/Salle A/B`, a path
   * naming another resource or none. Percent-encoding keeps it one segment.
   */
  private resourceUrl(resourceId: string): string {
    return `${this.webadminUrl}/resources/${encodeURIComponent(resourceId)}`;
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

    // The id is read from the DN, and from the DN only, so that the three
    // hooks name the same resource: the slug of the name used as a fallback
    // here created a resource the modify and delete hooks — which have no
    // such fallback — could never reach again.
    const id = this.getResourceId(dn);
    if (!id) {
      return null;
    }

    return {
      name,
      description,
      creator,
      domain,
      id,
    };
  }

  /**
   * The name a resource is known by in Calendar: the value of the entry's own
   * RDN, escapes removed.
   *
   * Taken from the first RDN, whatever its attribute type, so that an entity
   * whose mainAttribute is neither `cn` nor `uid` gets an id of its own. The
   * previous derivation looked for `cn=`/`uid=` anywhere in the DN, so
   * `o=Room 12,cn=zone,ou=resources,…` answered `zone`, its parent's id — a
   * modify on that entry then patched another resource. It also cut the value
   * at the first comma, escaped or not, so `cn=Salle\, 2` answered `Salle\`,
   * an id two rooms could share.
   *
   * A DN with `cn=` or `uid=` as its own first RDN and no escape in its value
   * — the shape a deployment has — answers exactly what it answered before.
   */
  private getResourceId(dn: string): string | null {
    return rdnValue(dn) || null;
  }

  /**
   * Find a Calendar registered user by email.
   *
   * `GET /registeredUsers?email=…` answers the one user, or 404. Calendar
   * lower-cases the address before matching it (James's `Username` folds both
   * parts), which is also how it stores every address, so a case difference
   * between LDAP and Calendar does not matter. The one record this misses is
   * a legacy one whose stored address kept upper case, written without going
   * through `Username`; the full-list lookup used before did find it.
   *
   * Calendar releases before 1.0.0.1 ignore the `email` parameter and answer
   * the full list; the user is then picked from it, case-insensitively.
   *
   * @param email Address Calendar holds for the user
   * @param log Log context of the calling sync
   * @returns The registered user, or null when it is not registered or the
   *   lookup failed (both logged)
   */
  private async findRegisteredUser(
    email: string,
    log: Record<string, unknown>
  ): Promise<RegisteredUser | null> {
    const lookupLog = {
      ...log,
      step: 'find_registered_user',
      searchEmail: email,
    };
    const url = new URL(`${this.webadminUrl}/registeredUsers`);
    url.searchParams.set('email', email);
    const res = await this.requestLimit(() =>
      fetch(url.toString(), {
        method: 'GET',
        headers: this.createHeaders(),
      })
    );

    if (res.status !== 404) {
      if (!res.ok) {
        this.logger.error({
          ...lookupLog,
          http_status: res.status,
          http_status_text: res.statusText,
        });
        return null;
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        this.logger.error({
          ...lookupLog,
          http_status: res.status,
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
          error: `unreadable answer: ${err}`,
        });
        return null;
      }

      if (!Array.isArray(body)) {
        if (isRegisteredUser(body)) return body;
        // Without an id there is nothing to PATCH: `?id=undefined` would go out
        this.logger.error({
          ...lookupLog,
          http_status: res.status,
          error: 'answer is not a registered user',
        });
        return null;
      }

      const user = body.find(
        u =>
          isRegisteredUser(u) && u.email?.toLowerCase() === email.toLowerCase()
      ) as RegisteredUser | undefined;
      if (user) return user;
    }

    this.logger.warn({
      ...lookupLog,
      message: 'user not registered in Calendar',
    });
    return null;
  }

  /**
   * Synchronize an LDAP user's identity (email, first and last name) to the
   * Twake Calendar registered users via the WebAdmin API.
   *
   * Registered users are keyed by an internal id: the user is looked up with
   * `GET /registeredUsers?email=…` (see findRegisteredUser), then
   * `PATCH /registeredUsers?id={id}` with the LDAP values.
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
      // Step 1: find the registered user by email
      const existing = await this.findRegisteredUser(searchEmail, log);
      if (!existing) return;

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
      // Left as it is written, deliberately. `@` is legal in a path segment
      // (RFC 3986), so encoding it buys nothing for an ordinary address, and
      // `plugins/twake/james` interpolates addresses raw into a dozen paths
      // of this same WebAdmin: changing one of the two would have them
      // disagree on the wire with nothing but a mock to say which is right.
      // See the issue tracking both.
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
