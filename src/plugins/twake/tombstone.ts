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
import type { Request } from 'express';
import type { SearchOptions } from 'ldapts';

import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import { BadRequestError } from '../../lib/errors';
import { changeContext } from '../../lib/changeContext';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { extractLdapCode } from '../../lib/ldapCodes';
import { escapeLdapFilter, launchHooks } from '../../lib/utils';

import {
  formatDeletedAt,
  isTombstone,
  lifecycleAttributes,
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
  private readonly scimPrefix: string;

  /** Deletes asked for through {@link tombstone}, with their reason. */
  private readonly reasonFor = new Map<string, string>();

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
    this.scimPrefix = cfg.scim_prefix || '/scim/v2';
    if (this.patterns.length === 0)
      this.logger.warn(
        `${this.name}: --twake-tombstone-dn is empty, every delete stays a delete`
      );
  }

  /**
   * Last in the delete chain: a plugin that may refuse the request
   * judges it before a tombstone is written.
   */
  afterLoad(): void {
    for (const name of ['ldapdeleterequest'] as const) {
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
        if (this.matches(one)) {
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
    await this.server.ldap.modify(
      dn,
      clear.length ? { replace, delete: clear } : { replace }
    );
    this.logger.info({ plugin: this.name, event: 'tombstone', dn, reason });
  }
}
