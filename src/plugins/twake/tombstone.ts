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
import { changeContext } from '../../lib/changeContext';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { extractLdapCode } from '../../lib/ldapCodes';
import {
  asyncHandler,
  escapeLdapFilter,
  isDnInBranch,
  launchHooks,
} from '../../lib/utils';

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
        if (this.keeps(one)) {
          const entry = await this.read(one);
          if (entry) {
            await this.writeTombstone(one, entry, this.reasonOf(one, req), req);
            continue;
          }
        }
        kept.push(one);
      }
      return [kept, req];
    },

    ldapaddrequest: async ([dn, entry, req]) => {
      if (this.isScim(req) && this.matches(dn)) {
        const existing = await this.read(dn);
        if (existing && isTombstone(existing, this.attrs))
          await this.replace(dn, existing, req!);
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
      if (!at)
        throw new ConflictError(
          `${dn} holds no readable deletion date (--twake-lifecycle-deleted-at-attribute); force it to erase now`
        );
      if (Date.now() - at.getTime() < this.eraseMinAge * 1000)
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

  /**
   * Whether a delete of this DN, asked for now, writes a tombstone instead of
   * reaching the directory: not when it erases one.
   */
  keeps(dn: string): boolean {
    return !this.erasing.has(dn) && this.matches(dn);
  }

  /**
   * core/ldap/trash moves a deleted entry away before this plugin, last in
   * the delete chain, sees it: no tombstone would be written, and an erase
   * would move the tombstone instead of removing it.
   */
  assertComposition(): void {
    if (!this.server.loadedPlugins.trash) return;
    // Read as core/ldap/trash reads it, none meaning every branch
    const watched = String(this.config.trash_watched_bases || '')
      .split(';')
      .map(base => base.trim())
      .filter(Boolean);
    const clash = this.patterns.filter(p => {
      const branch = p.source.replace(/\$$/, '');
      return (
        watched.length === 0 ||
        watched.some(
          base => isDnInBranch(branch, base) || isDnInBranch(base, branch)
        )
      );
    });
    if (clash.length)
      throw new Error(
        `${this.name}: core/ldap/trash watches the branch of ${clash
          .map(p => p.source)
          .join(', ')}, and would move those entries instead of leaving ` +
          `a tombstone. Leave that branch out of --trash-watched-bases, or ` +
          `load one of the two plugins only`
      );
  }

  /**
   * Erase a tombstone so a SCIM create can take its identity. The directory
   * may still refuse the add; the tombstone and its memberships are then put
   * back once the response is sent.
   */
  private async replace(
    dn: string,
    tombstone: AttributesList,
    req: Request
  ): Promise<void> {
    const groups = await this.groupsOf(dn);
    const dummy = this.config.group_dummy_user;
    const placeholders = new Set(dummy ? await this.groupsOf(dummy) : []);
    await this.erase(dn, { force: true, req });
    const res = req.res;
    if (!res) return;
    // Not on 'close': it also fires when the client goes away, possibly
    // before the add is issued, and 'finish' then never fires at all. The
    // handler ends the response once the add has settled, client or not.
    const end = res.end.bind(res);
    res.end = ((...args: unknown[]) => {
      res.end = end;
      const ended = (end as (...a: unknown[]) => Response)(...args);
      this.restore(dn, tombstone, groups, placeholders).catch((err: unknown) =>
        this.logger.error({
          plugin: this.name,
          event: 'restore',
          dn,
          error: String(err),
        })
      );
      return ended;
    }) as typeof end;
  }

  /**
   * Put back a tombstone the add did not replace, with its memberships. A
   * group the erase left holding only the placeholder loses it again.
   */
  private async restore(
    dn: string,
    tombstone: AttributesList,
    groups: string[],
    placeholders: Set<string>
  ): Promise<void> {
    if (await this.read(dn)) return;
    // ldapts lists an attribute asked for by name even when the entry has
    // none, and an add refuses an attribute without values.
    const attributes = Object.fromEntries(
      Object.entries(tombstone).filter(
        ([name, value]) =>
          name !== 'dn' && !(Array.isArray(value) && value.length === 0)
      )
    );
    await this.server.ldap.add(dn, attributes);
    const dummy = this.config.group_dummy_user;
    for (const group of groups) {
      await this.server.ldap.modify(group, { add: { member: dn } });
      if (!dummy || placeholders.has(group)) continue;
      await this.server.ldap
        .modify(group, { delete: { member: dummy } })
        .catch((err: unknown) => {
          // No placeholder: the group was not left empty.
          if (extractLdapCode(err) !== 16) throw err;
        });
    }
    this.logger.warn({ plugin: this.name, event: 'restore', dn });
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
    reason: string,
    req?: Request
  ): Promise<void> {
    const { attrs } = this;
    if (isTombstone(entry, attrs)) {
      // Deleting a tombstone again writes nothing, and a write changing
      // nothing announces nothing: say so to whoever replays the deletion,
      // with the date the first deletion wrote.
      void launchHooks(
        this.server.hooks.twakedeletionreplay,
        dn,
        entry,
        changeContext(req)
      );
      this.logger.info({ plugin: this.name, event: 'replay', dn });
      return;
    }
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
    // Announced as the deleting request, not authorized as it: the delete
    // already was, and a caller may hold delete rights without write ones.
    await this.server.ldap.modify(
      dn,
      clear.length ? { replace, delete: clear } : { replace },
      undefined,
      { context: changeContext(req) }
    );
    this.logger.info({ plugin: this.name, event: 'tombstone', dn, reason });
  }

  private async groupsOf(dn: string): Promise<string[]> {
    const found: string[] = [];
    for (const base of this.groupBases.filter(Boolean)) {
      try {
        const groups = (await this.server.ldap.search(
          {
            paged: false,
            scope: 'sub',
            filter: `(member=${escapeLdapFilter(dn)})`,
            attributes: ['dn'],
          },
          base
        )) as SearchResult;
        found.push(...groups.searchEntries.map(g => g.dn));
      } catch (err) {
        if (extractLdapCode(err) !== 32) throw err;
      }
    }
    return found;
  }

  private async leaveGroups(dn: string): Promise<void> {
    for (const group of await this.groupsOf(dn))
      await this.leaveGroup(group, dn);
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
