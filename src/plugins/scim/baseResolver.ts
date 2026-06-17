/**
 * @module plugins/scim/baseResolver
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Resolve per-request LDAP bases for SCIM Users and Groups.
 *
 * Resolution order (user → group identical):
 *   1. Explicit map entry for req.user   (scim_base_map → { "<user>": { userBase, groupBase } })
 *   2. Request header                    (scim_user_base_header / scim_group_base_header)
 *   3. Wildcard map entry "*"            (scim_base_map → { "*": { ... } })
 *   4. Template substitution             (scim_user_base_template / scim_group_base_template)
 *   5. Static config value               (scim_user_base / scim_group_base)
 *   6. Global fallback                   (ldap_base)
 *
 * The `{user}` placeholder in templates is substituted with req.user after
 * `escapeDnValue()` sanitization, to prevent DN-injection.
 *
 * A header-supplied base is only honored when `scim_base_header_root` is
 * explicitly configured AND the value sits at or under that root AND contains
 * no control characters, so a header cannot redirect operations to an arbitrary
 * DN or inject into the DN. An explicit per-user map entry still wins over the
 * header, so identity-based pinning is never silently overridden.
 */
import fs from 'fs';

import type { Config } from '../../config/args';
import type { DmRequest } from '../../lib/auth/base';
import { escapeDnValue, isChildOf } from '../../lib/utils';

export interface BaseMapEntry {
  userBase?: string;
  groupBase?: string;
}
export type BaseMap = Record<string, BaseMapEntry>;

export class BaseResolver {
  private readonly defaultUserBase: string;
  private readonly defaultGroupBase: string;
  private readonly userTemplate: string;
  private readonly groupTemplate: string;
  private readonly map: BaseMap | undefined;
  private readonly userBaseHeader: string;
  private readonly groupBaseHeader: string;
  private readonly headerRoot: string;

  constructor(config: Config) {
    const fallback = config.ldap_base || '';
    this.defaultUserBase = (config.scim_user_base as string) || fallback;
    this.defaultGroupBase = (config.scim_group_base as string) || fallback;
    this.userTemplate = (config.scim_user_base_template as string) || '';
    this.groupTemplate = (config.scim_group_base_template as string) || '';
    this.userBaseHeader = (
      (config.scim_user_base_header as string) || ''
    ).toLowerCase();
    this.groupBaseHeader = (
      (config.scim_group_base_header as string) || ''
    ).toLowerCase();
    this.headerRoot = (config.scim_base_header_root as string) || '';

    const mapPath = (config.scim_base_map as string) || '';
    if (mapPath) {
      try {
        const content = fs.readFileSync(mapPath, 'utf8');
        this.map = JSON.parse(content) as BaseMap;
      } catch (err) {
        throw new Error(
          `Failed to load SCIM base map from ${mapPath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  private applyTemplate(template: string, user: string | undefined): string {
    const safe = user ? escapeDnValue(user) : '';
    return template.replace(/\{user\}/g, safe);
  }

  /** Read a request header by name, tolerating Express req or a plain object. */
  private readHeader(
    req: DmRequest | { user?: string } | undefined,
    name: string
  ): string | undefined {
    if (!req || typeof req !== 'object') return undefined;
    const r = req as {
      get?: (n: string) => string | undefined;
      headers?: Record<string, string | string[] | undefined>;
    };
    if (typeof r.get === 'function') {
      const v = r.get(name);
      if (typeof v === 'string' && v.length > 0) return v;
    }
    const h = r.headers?.[name];
    if (typeof h === 'string' && h.length > 0) return h;
    if (Array.isArray(h) && typeof h[0] === 'string' && h[0].length > 0) {
      return h[0];
    }
    return undefined;
  }

  private resolve(
    kind: 'user' | 'group',
    req?: DmRequest | { user?: string }
  ): string {
    const user =
      req && typeof req === 'object' && 'user' in req ? req.user : undefined;

    // 1. Explicit map entry (identity pinning wins over a request header)
    if (this.map && user && this.map[user]) {
      const entry = this.map[user];
      if (kind === 'user' && entry.userBase) return entry.userBase;
      if (kind === 'group' && entry.groupBase) return entry.groupBase;
    }
    // 2. Request header — only when an explicit root is configured, the value
    //    is at/under it, and it carries no control characters.
    const headerName =
      kind === 'user' ? this.userBaseHeader : this.groupBaseHeader;
    if (headerName && this.headerRoot) {
      const fromHeader = this.readHeader(req, headerName)?.trim();
      if (
        fromHeader &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f]/.test(fromHeader) &&
        (fromHeader.toLowerCase() === this.headerRoot.toLowerCase() ||
          isChildOf(fromHeader, this.headerRoot))
      ) {
        return fromHeader;
      }
      // No root, outside the root, or unsafe value: ignore, fall through.
    }
    // 3. Wildcard map entry
    if (this.map && this.map['*']) {
      const entry = this.map['*'];
      if (kind === 'user' && entry.userBase)
        return this.applyTemplate(entry.userBase, user);
      if (kind === 'group' && entry.groupBase)
        return this.applyTemplate(entry.groupBase, user);
    }
    // 3. Template
    const template = kind === 'user' ? this.userTemplate : this.groupTemplate;
    if (template) return this.applyTemplate(template, user);
    // 4. Static / 5. Fallback
    return kind === 'user' ? this.defaultUserBase : this.defaultGroupBase;
  }

  userBase(req?: DmRequest | { user?: string }): string {
    return this.resolve('user', req);
  }

  groupBase(req?: DmRequest | { user?: string }): string {
    return this.resolve('group', req);
  }
}
