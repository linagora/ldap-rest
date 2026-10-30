/**
 * @module plugins/twake/migrationProxy
 *
 * Keeps the migrated-users list of the Twake Mail migration proxy in step
 * with the accounts of the directory: an account created during the
 * migration has no mailbox on the old system, so the proxy has to route it
 * to the new one from its first login, and the addresses of a migrated
 * account have to follow it.
 *
 * See `docs/usage/plugins/integrations/mail-migration.md`.
 */
import { Type } from '@sinclair/typebox';
import type { Express, Request, Response } from 'express';

import TwakePlugin from '../../abstract/twakePlugin';
import { defineRoute, type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import type { HealthStatus } from '../../lib/health';
import type { AttributesList } from '../../lib/ldapActions';
import { wantJson } from '../../lib/expressFormatedResponses';
import { isDnInBranch, normalizeDn } from '../../lib/utils';

/** What the proxy answers while its storage does not */
const PROXY_UNAVAILABLE: readonly number[] = [500, 502, 503, 504];

/** A proxy that holds a connection without answering must not hold a slot */
const HEAD_TIMEOUT_MS = 10_000;

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

  private readonly branches: string[];
  private readonly aliasAttr: string;
  /** The work on one entry waits for the work before it */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(server: DM) {
    super(server, {
      url: server.config.migration_proxy_url || '',
      token: server.config.migration_proxy_token || '',
      concurrency: server.config.migration_proxy_concurrency ?? 10,
      urlOption: 'migration_proxy_url',
      tokenOption: 'migration_proxy_token',
      concurrencyOption: 'migration_proxy_concurrency',
    });
    this.branches = this.config.migration_proxy_branch || [];
    if (!this.branches.length)
      throw new Error(`${this.name}: --migration-proxy-branch is required`);
    this.aliasAttr =
      (this.config.alias_attribute as string) || 'mailAlternateAddress';
    this.retryAttempts =
      typeof this.config.migration_proxy_retry_attempts === 'number'
        ? Math.max(1, this.config.migration_proxy_retry_attempts)
        : 5;
    this.retryDelay =
      typeof this.config.migration_proxy_retry_delay === 'number'
        ? Math.max(0, this.config.migration_proxy_retry_delay)
        : 1000;
  }

  health(): Promise<HealthStatus> {
    return this.webadminHealth();
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
    defineRoute(app, {
      method: 'get',
      path: `${apiPrefix}/v1/users/:user/mail-migration`,
      params: Type.Object({ user: Type.String({ minLength: 1 }) }),
      handler: async ({ req, res }) => this.getMigrationStatus(req, res),
    });
  }

  hooks: Hooks = {
    onLdapEntryChange: (dn, before, after) => {
      if (!this.branches.some(branch => isDnInBranch(dn, branch))) return;
      return this.inOrder(dn, () =>
        this.follow(
          dn,
          before as AttributesList | null,
          after as AttributesList | null
        )
      );
    },
  };

  /**
   * One entry at a time: two writes close together would otherwise race to
   * the proxy, the second reading a list the first has not written yet
   */
  private inOrder(dn: string, step: () => Promise<void>): Promise<void> {
    let key: string;
    try {
      key = normalizeDn(dn);
    } catch {
      key = dn.toLowerCase();
    }
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(step, step);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }

  /**
   * The address the entry logs in with, and the ones that reach it, each
   * once: an alias repeating the mail would otherwise be put and taken off
   * in the same breath
   */
  private addresses(entry: AttributesList | null): {
    primary: string | null;
    all: string[];
  } {
    if (!entry) return { primary: null, all: [] };
    const mails = this.getAliases(entry[this.mailAttr]);
    const seen = new Set<string>();
    const all = [...mails, ...this.getAliases(entry[this.aliasAttr])].filter(
      address => {
        const key = address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }
    );
    return { primary: mails[0] ?? null, all };
  }

  /**
   * An entry gaining its address is put on the list with all of them, one
   * losing it is taken off; one keeping it has its addresses follow it when
   * the proxy says it is migrated, and is left to the migration otherwise.
   * The proxy folds usernames to lower case, so a change of case is none.
   */
  private async follow(
    dn: string,
    before: AttributesList | null,
    after: AttributesList | null
  ): Promise<void> {
    const was = this.addresses(before);
    const is = this.addresses(after);
    const lower = (list: string[]): Set<string> =>
      new Set(list.map(a => a.toLowerCase()));
    const wasSet = lower(was.all);
    const isSet = lower(is.all);
    const added = is.all.filter(a => !wasSet.has(a.toLowerCase()));
    const removed = was.all.filter(a => !isSet.has(a.toLowerCase()));
    if (!added.length && !removed.length) return;

    let event: string;
    if (!was.primary) event = 'onLdapEntryChange:add';
    else if (!is.primary) event = 'onLdapEntryChange:delete';
    else {
      event = 'onLdapEntryChange:update';
      const log = {
        plugin: this.name,
        event,
        dn,
        mail: was.primary,
        added,
        removed,
      };
      let migrated: boolean;
      try {
        migrated = await this.isMigrated(was.primary, true);
      } catch (err) {
        this.logger.error({
          ...log,
          result: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!migrated) {
        this.logger.debug({ ...log, result: 'ignored' });
        return;
      }
    }

    // The additions first, and the removals only once they all hold: a
    // login or a mail between the two must find the account on the list
    const put = await Promise.all(
      added.map(address => this.call(event, dn, 'PUT', address))
    );
    if (!put.every(Boolean)) return;
    await Promise.all(
      removed.map(address => this.call(event, dn, 'DELETE', address))
    );
  }

  private userUrl(address: string): string {
    return `${this.webadminUrl}/migratedUsers/${encodeURIComponent(address)}`;
  }

  private call(
    event: string,
    dn: string,
    method: 'PUT' | 'DELETE',
    address: string
  ): Promise<boolean> {
    return this.callWebAdminApi(
      event,
      this.userUrl(address),
      method,
      dn,
      null,
      { mail: address },
      PROXY_UNAVAILABLE
    );
  }

  /**
   * `HEAD /migratedUsers/{user}`: 204 when migrated, 404 otherwise. With
   * `retry`, an answer of {@link PROXY_UNAVAILABLE} is asked again as a
   * write would be; throws once the proxy has not said
   */
  async isMigrated(address: string, retry = false): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.requestLimit(() =>
        this.fetch(this.userUrl(address), {
          method: 'HEAD',
          headers: this.createHeaders(),
          signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
        })
      );
      if (res.status === 404) return false;
      if (res.ok) return true;
      if (retry && this.shouldRetry(res.status, PROXY_UNAVAILABLE, attempt)) {
        await this.waitBeforeRetry(attempt);
        continue;
      }
      throw new Error(
        `Migration proxy answered ${res.status} ${res.statusText}`
      );
    }
  }

  private async getMigrationStatus(req: Request, res: Response): Promise<void> {
    if (!wantJson(req, res)) return;
    const username = req.params.user as string;
    const entry = await this.findReadableUser(username, req, [this.mailAttr]);
    if (!entry) {
      res.status(404).json({ error: `User ${username} not found` });
      return;
    }
    const mail = this.attributeToString(entry[this.mailAttr]);
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
      res.status(502).json({ error: 'Failed to ask the migration proxy' });
    }
  }
}
