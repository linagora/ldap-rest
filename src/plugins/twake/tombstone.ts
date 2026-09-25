/**
 * @module plugins/twake/tombstone
 *
 * Turns the delete of an account into a tombstone: the entry stays, flagged
 * as deleted, dated, locked, with the reason and without the attributes the
 * deployment wants gone. The address it holds cannot be taken again until the
 * tombstone is erased.
 *
 * SCIM treats a tombstone as gone. Erasing removes the entry and its group
 * memberships, once the deletion is old enough or when forced, and announces
 * nothing: the deletion already did.
 *
 * See `docs/usage/plugins/integrations/tombstone.md`.
 */
import type { Express, Request, Response } from 'express';
import type { SearchOptions } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../../lib/errors';
import { jsonBody } from '../../lib/expressFormatedResponses';
import type {
  AttributesList,
  ModifyRequest,
  SearchResult,
} from '../../lib/ldapActions';
import { extractLdapCode } from '../../lib/ldapCodes';
import { asyncHandler, escapeLdapFilter } from '../../lib/utils';

import {
  first,
  formatDeletedAt,
  isTombstone,
  lifecycleAttributes,
  parseDeletedAt,
  valueOf,
  type LifecycleAttributes,
} from './lifecycleAttributes';

const REASON = /^[A-Za-z0-9_.-]{1,64}$/;

export default class TwakeTombstone extends DmPlugin {
  name = 'twakeTombstone';
  roles: Role[] = ['consistency', 'api'] as const;

  private readonly attrs: LifecycleAttributes;
  private readonly patterns: RegExp[];
  private readonly defaultReason: string;
  private readonly reasonHeader: string;
  private readonly reasons: string[];
  private readonly clearAttributes: string[];
  private readonly eraseMinAge: number;
  private readonly groupBases: string[];
  private readonly scimPrefix: string;

  /** Deletes asked for through {@link tombstone}, with their reason. */
  private readonly reasonFor = new Map<string, string>();
  /** Entries being erased: their delete must reach the directory. */
  private readonly erasing = new Set<string>();

  constructor(server: DM) {
    super(server);
    const cfg = this.config;
    this.attrs = lifecycleAttributes(cfg);
    if (!this.attrs.deleted)
      throw new Error(
        `${this.name}: --twake-lifecycle-deleted-attribute is required`
      );
    this.patterns = (cfg.twake_tombstone_dn || []).map(p => new RegExp(p, 'i'));
    this.reasons = cfg.twake_tombstone_reasons || [];
    this.defaultReason = this.checkReason(
      cfg.twake_tombstone_default_reason || 'deleted'
    );
    this.reasonHeader = (
      cfg.twake_tombstone_reason_header || 'x-deletion-reason'
    ).toLowerCase();
    this.clearAttributes = cfg.twake_tombstone_clear_attributes || [];
    this.eraseMinAge = cfg.twake_tombstone_erase_min_age ?? 2592000;
    this.groupBases = cfg.twake_tombstone_group_bases?.length
      ? cfg.twake_tombstone_group_bases
      : [cfg.ldap_group_base || cfg.ldap_base || ''];
    this.scimPrefix = cfg.scim_prefix || '/scim/v2';
    if (this.patterns.length === 0)
      this.logger.warn(
        `${this.name}: --twake-tombstone-dn is empty, every delete stays a delete`
      );
  }

  /**
   * Last in the delete and add chains: a plugin that may refuse the request
   * judges it before a tombstone is written or erased.
   */
  afterLoad(): void {
    for (const name of ['ldapdeleterequest', 'ldapaddrequest'] as const) {
      const list = this.server.hooks[name];
      const own = this.hooks[name];
      const at = list && own ? list.indexOf(own) : -1;
      if (at < 0) continue;
      list!.splice(at, 1);
      list!.push(own!);
    }
  }

  hooks: Hooks = {
    ldapdeleterequest: async ([dn, req]) => {
      const kept: string[] = [];
      for (const one of Array.isArray(dn) ? dn : [dn]) {
        if (!this.erasing.has(one) && this.matches(one)) {
          const entry = await this.read(one);
          if (entry) {
            await this.writeTombstone(one, entry, this.reasonOf(one, req));
            continue;
          }
        }
        kept.push(one);
      }
      return [kept, req];
    },

    // A SCIM create reusing the identity of a tombstone replaces it.
    ldapaddrequest: async ([dn, entry, req]) => {
      if (this.isScim(req) && this.matches(dn)) {
        const existing = await this.read(dn);
        if (existing && isTombstone(existing, this.attrs))
          await this.erase(dn, { force: true, req });
      }
      return [dn, entry, req];
    },

    ldapsearchrequest: ([base, opts, req]) => {
      if (!this.isScim(req)) return [base, opts, req];
      const filter = opts.filter || '(objectClass=*)';
      const hidden = `(!(${this.attrs.deleted}=${escapeLdapFilter(this.attrs.deletedValue)}))`;
      return [
        base,
        {
          ...opts,
          filter: `(&${String(filter).startsWith('(') ? String(filter) : `(${String(filter)})`}${hidden})`,
        } as SearchOptions,
        req,
      ];
    },
  };

  api(app: Express): void {
    /**
     * @openapi
     * summary: Erase a tombstone
     * description: |
     *   Removes a deleted account for good, with its group memberships. The
     *   deletion must be older than `--twake-tombstone-erase-min-age`, unless
     *   `force` is true. Nothing is published.
     * tags:
     *   - Twake
     * requestBody:
     *   required: true
     *   content:
     *     application/json:
     *       schema:
     *         type: object
     *         required: [dn]
     *         properties:
     *           dn: { type: string }
     *           force: { type: boolean, default: false }
     * responses:
     *   '200':
     *     description: Erased.
     *     content:
     *       application/json:
     *         example: { success: true }
     *   '404':
     *     description: No tombstone at this DN.
     *   '409':
     *     description: The deletion is too recent and `force` is not set.
     */
    app.post(
      `${this.config.api_prefix}/v1/twake/tombstones/erase`,
      asyncHandler(async (req: Request, res: Response) => {
        const body = jsonBody(req, res, 'dn') as
          | { dn: unknown; force?: unknown }
          | false;
        if (!body) return;
        if (typeof body.dn !== 'string')
          throw new BadRequestError('Field dn must be a string');
        await this.erase(body.dn, { force: body.force === true, req });
        res.json({ success: true });
      })
    );
  }

  /**
   * Delete an entry as a tombstone recording this reason. Goes through the
   * directory's delete, so every plugin judging deletes judges this one.
   */
  async tombstone(dn: string, reason: string, req?: Request): Promise<void> {
    if (!this.matches(dn))
      throw new BadRequestError(
        `${dn} is not an entry that becomes a tombstone`
      );
    this.reasonFor.set(dn, this.checkReason(reason));
    try {
      await this.server.ldap.delete(dn, req);
    } finally {
      this.reasonFor.delete(dn);
    }
  }

  /**
   * Remove a tombstone and its group memberships. Refused while the deletion
   * is younger than the configured age, unless forced.
   */
  async erase(
    dn: string,
    { force = false, req }: { force?: boolean; req?: Request } = {}
  ): Promise<void> {
    const entry = await this.read(dn);
    if (!entry || !isTombstone(entry, this.attrs))
      throw new NotFoundError(`No tombstone at ${dn}`);
    if (!force) {
      const raw = first(valueOf(entry, this.attrs.deletedAt));
      const at = raw && parseDeletedAt(raw, this.attrs.deletedAtFormat);
      if (!at || Date.now() - at.getTime() < this.eraseMinAge * 1000)
        throw new ConflictError(
          `${dn} was deleted less than ${this.eraseMinAge} seconds ago; force it to erase now`
        );
    }
    this.erasing.add(dn);
    try {
      await this.server.ldap.delete(dn, req);
    } finally {
      this.erasing.delete(dn);
    }
    // Only once the delete has been judged and has landed: a refused erase
    // keeps the memberships.
    await this.leaveGroups(dn);
    this.logger.info({ plugin: this.name, event: 'erase', dn, force });
  }

  private matches(dn: string): boolean {
    return this.patterns.some(p => p.test(dn));
  }

  private isScim(req?: Request): boolean {
    const url = req?.originalUrl ?? req?.url;
    return typeof url === 'string' && url.startsWith(this.scimPrefix);
  }

  private checkReason(reason: string): string {
    const ok = this.reasons.length
      ? this.reasons.includes(reason)
      : REASON.test(reason);
    if (!ok)
      throw new BadRequestError(
        `Unknown deletion reason "${reason}"${this.reasons.length ? `; known: ${this.reasons.join(', ')}` : ''}`
      );
    return reason;
  }

  private reasonOf(dn: string, req?: Request): string {
    const given = this.reasonFor.get(dn);
    if (given) return given;
    const header = req?.headers?.[this.reasonHeader];
    const value = Array.isArray(header) ? header[0] : header;
    return value ? this.checkReason(value) : this.defaultReason;
  }

  private async read(dn: string): Promise<AttributesList | undefined> {
    try {
      const res = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['*', this.attrs.lock] },
        dn
      )) as SearchResult;
      return res.searchEntries[0] as AttributesList | undefined;
    } catch (err) {
      if (extractLdapCode(err) === 32) return undefined;
      throw err;
    }
  }

  private async writeTombstone(
    dn: string,
    entry: AttributesList,
    reason: string
  ): Promise<void> {
    const { attrs } = this;
    let changes: ModifyRequest;
    if (isTombstone(entry, attrs)) {
      // Deleting a tombstone again announces the deletion again; its date
      // stays the one the first deletion wrote.
      changes = { replace: { [attrs.deleted]: attrs.deletedValue } };
    } else {
      const replace: AttributesList = {
        [attrs.deleted]: attrs.deletedValue,
        [attrs.lock]: attrs.lockValue,
      };
      if (attrs.deletedAt)
        replace[attrs.deletedAt] = formatDeletedAt(
          new Date(),
          attrs.deletedAtFormat
        );
      if (attrs.reason) replace[attrs.reason] = reason;
      const clear = this.clearAttributes.filter(
        a => valueOf(entry, a) !== undefined
      );
      changes = clear.length ? { replace, delete: clear } : { replace };
    }
    await this.server.ldap.modify(dn, changes);
    // core/ldap/onChange kept the entry to announce its removal, which is
    // not coming.
    (
      this.server.loadedPlugins.onLdapChange as
        | { pendingDeletions?: Map<string, unknown> }
        | undefined
    )?.pendingDeletions?.delete(dn);
    this.logger.info({ plugin: this.name, event: 'tombstone', dn, reason });
  }

  private async leaveGroups(dn: string): Promise<void> {
    for (const base of this.groupBases.filter(Boolean)) {
      let groups: SearchResult;
      try {
        groups = (await this.server.ldap.search(
          {
            paged: false,
            scope: 'sub',
            filter: `(member=${escapeLdapFilter(dn)})`,
            attributes: ['dn'],
          },
          base
        )) as SearchResult;
      } catch (err) {
        if (extractLdapCode(err) === 32) continue;
        throw err;
      }
      for (const group of groups.searchEntries)
        await this.leaveGroup(group.dn, dn);
    }
  }

  /**
   * core/ldap/groups and refint clean the same memberships once the delete
   * lands, so each outcome of a race with them counts as done.
   */
  private async leaveGroup(group: string, dn: string): Promise<void> {
    const dummy = this.config.group_dummy_user;
    let placeholder = false;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.server.ldap.modify(
          group,
          placeholder
            ? { add: { member: dummy! }, delete: { member: dn } }
            : { delete: { member: dn } }
        );
        return;
      } catch (err) {
        const code = extractLdapCode(err);
        // Already removed.
        if (code === 16) return;
        if (attempt >= 2) throw err;
        // The last member of a groupOfNames hands its place to the
        // placeholder core/ldap/groups keeps in empty groups; one already
        // there means someone else did, and only the member is left to go.
        if (code === 65 && dummy) placeholder = true;
        else if (code === 20) placeholder = false;
        else throw err;
      }
    }
  }
}
