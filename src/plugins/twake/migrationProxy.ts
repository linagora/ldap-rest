/**
 * @module plugins/twake/migrationProxy
 *
 * Keeps the migrated-users list of the Twake Mail migration proxy in step
 * with the accounts of the directory: an account created during the
 * migration has no mailbox on the old system, so the proxy has to route it
 * to the new one from its first login.
 *
 * See `docs/usage/plugins/integrations/mail-migration.md`.
 */
import type { Express, Request, Response } from 'express';

import TwakePlugin from '../../abstract/twakePlugin';
import { type Role, asyncHandler } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import { PROBE_TIMEOUT_MS, type HealthStatus } from '../../lib/health';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { wantJson } from '../../lib/expressFormatedResponses';
import { escapeLdapFilter } from '../../lib/utils';

/** Under the probe's budget, so that a mute proxy reads as degraded */
const HEALTHCHECK_TIMEOUT_MS = PROBE_TIMEOUT_MS - 500;

/** What the proxy answers while its storage does not */
const PROXY_UNAVAILABLE = [500, 502, 503, 504] as const;

// The list is keyed by the users who log in: the address of a group is a
// mailing list or a team mailbox, which the old system never hosted under
// that name
const GROUP_CLASSES = ['groupofnames', 'groupofuniquenames', 'groupofurls'];
const isGroup = (classes: unknown): boolean =>
  (Array.isArray(classes) ? classes : classes ? [classes] : []).some(c =>
    GROUP_CLASSES.includes(String(c).toLowerCase())
  );

const first = (value: unknown): string | null => {
  const one = (Array.isArray(value) ? value[0] : value) as
    | string
    | Buffer
    | undefined
    | null;
  const text = one === undefined || one === null ? '' : one.toString();
  return text || null;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     MailMigrationStatus:
 *       type: object
 *       required: [migrated]
 *       properties:
 *         migrated:
 *           type: boolean
 *           description: Whether the proxy routes the user to the new backend
 */
export default class MigrationProxy extends TwakePlugin {
  name = 'migrationProxy';
  roles: Role[] = ['consistency', 'api'] as const;

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
  };

  constructor(server: DM) {
    super(
      server,
      'migration_proxy_url',
      'migration_proxy_token',
      'migration_proxy_concurrency'
    );
    this.webadminUrl = this.webadminUrl.replace(/\/+$/, '');
    this.retryAttempts =
      typeof this.config.migration_proxy_retry_attempts === 'number'
        ? Math.max(1, this.config.migration_proxy_retry_attempts)
        : 5;
    this.retryDelay =
      typeof this.config.migration_proxy_retry_delay === 'number'
        ? Math.max(0, this.config.migration_proxy_retry_delay)
        : 1000;
  }

  /** The proxy's own health check, asked by the readiness probe outside the request queue */
  async health(): Promise<HealthStatus> {
    try {
      const res = await this.fetch(`${this.webadminUrl}/healthcheck`, {
        headers: this.createHeaders(),
        signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      });
      return res.ok ? 'ok' : 'degraded';
    } catch {
      return 'degraded';
    }
  }

  api(app: Express): void {
    const apiPrefix = this.config.api_prefix || '/api';

    /**
     * @openapi
     * summary: Where the migration proxy routes a user
     * description: |
     *   Asks the Twake Mail migration proxy whether the user is on its
     *   migrated list, that is routed to the new backend. The user is
     *   found by `uid` across the directory and answered only when the
     *   caller can read the entry.
     * tags:
     *   - Apache James Integration
     * responses:
     *   '200':
     *     description: The answer of the proxy.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/MailMigrationStatus' }
     *         example:
     *           migrated: true
     *   '400':
     *     description: User has no mail attribute.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '404':
     *     description: User not found, or not readable by the caller.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     *   '502':
     *     description: The proxy is unreachable or answered an error.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Error' }
     */
    app.get(
      `${apiPrefix}/v1/users/:user/mail-migration`,
      asyncHandler((req: Request, res: Response) =>
        this.getMigrationStatus(req, res)
      )
    );
  }

  hooks: Hooks = {
    onLdapEntryChange: async (dn, before, after) => {
      const was = isGroup(before?.objectClass)
        ? null
        : first(before?.[this.mailAttr]);
      const is = isGroup(after?.objectClass)
        ? null
        : first(after?.[this.mailAttr]);
      if (was === is) return;
      if (!was) {
        if (is) await this.markMigrated('onLdapEntryChange:add', dn, is);
      } else if (!is) {
        await this.unmark('onLdapEntryChange:delete', dn, was);
      } else {
        await this.follow(dn, was, is);
      }
    },
  };

  private userUrl(mail: string): string {
    return `${this.webadminUrl}/migratedUsers/${encodeURIComponent(mail)}`;
  }

  private markMigrated(event: string, dn: string, mail: string): Promise<void> {
    return this.callWebAdminApi(
      event,
      this.userUrl(mail),
      'PUT',
      dn,
      null,
      { mail },
      PROXY_UNAVAILABLE
    );
  }

  private unmark(event: string, dn: string, mail: string): Promise<void> {
    return this.callWebAdminApi(
      event,
      this.userUrl(mail),
      'DELETE',
      dn,
      null,
      { mail },
      PROXY_UNAVAILABLE
    );
  }

  /**
   * A renamed user stays on its side: a migrated one is put on the list
   * under its new address and taken off under the old one; one still on
   * the old system is left to the migration.
   */
  private async follow(
    dn: string,
    oldMail: string,
    newMail: string
  ): Promise<void> {
    let migrated: boolean;
    try {
      migrated = await this.isMigrated(oldMail);
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'onLdapEntryChange:rename',
        result: 'error',
        dn,
        oldmail: oldMail,
        newmail: newMail,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!migrated) {
      this.logger.debug({
        plugin: this.name,
        event: 'onLdapEntryChange:rename',
        result: 'ignored',
        dn,
        oldmail: oldMail,
        newmail: newMail,
      });
      return;
    }
    // The new address first: a login between the two calls lands on the
    // old backend otherwise
    await this.markMigrated('onLdapEntryChange:rename', dn, newMail);
    await this.unmark('onLdapEntryChange:rename', dn, oldMail);
  }

  /** `HEAD /migratedUsers/{user}`: 204 when migrated, 404 otherwise */
  async isMigrated(mail: string): Promise<boolean> {
    const res = await this.requestLimit(() =>
      this.fetch(this.userUrl(mail), {
        method: 'HEAD',
        headers: this.createHeaders(),
      })
    );
    if (res.status === 404) return false;
    if (!res.ok)
      throw new Error(
        `Migration proxy answered ${res.status} ${res.statusText}`
      );
    return true;
  }

  private async getMigrationStatus(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const username = req.params.user as string;

    // As the server: found across branches, then answered only if the
    // caller can read it, so that a user the caller cannot read gets the
    // answer a user that is not there gets
    const found = (await this.server.ldap.system.search(
      {
        scope: 'sub',
        filter: `(uid=${escapeLdapFilter(username)})`,
        paged: false,
        attributes: [this.mailAttr],
      },
      this.config.ldap_base || ''
    )) as SearchResult;
    let entry: AttributesList | undefined;
    for (const candidate of found.searchEntries ?? [])
      if (await this.server.ldap.readableBy(String(candidate.dn), req)) {
        entry = candidate as AttributesList;
        break;
      }
    if (!entry) {
      res.status(404).json({ error: `User ${username} not found` });
      return;
    }
    const mail = first(entry[this.mailAttr]);
    if (!mail) {
      res.status(400).json({ error: `User ${username} has no mail attribute` });
      return;
    }

    try {
      res.json({ migrated: await this.isMigrated(mail) });
    } catch (err) {
      this.logger.error({
        plugin: this.name,
        event: 'getMigrationStatus',
        username,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({
        error: 'Failed to ask the migration proxy',
      });
    }
  }
}
