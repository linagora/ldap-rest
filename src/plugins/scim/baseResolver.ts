/**
 * @module plugins/scim/baseResolver
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Resolve per-request LDAP bases for SCIM Users and Groups.
 *
 * Resolution order (user → group identical):
 *   1. Explicit map entry for req.user   (scim_base_map → { "<user>": { userBase, groupBase } })
 *   2. Wildcard map entry "*"            (scim_base_map → { "*": { ... } })
 *   3. Template substitution             (scim_user_base_template / scim_group_base_template)
 *   4. Static config value               (scim_user_base / scim_group_base)
 *   5. Global fallback                   (ldap_base)
 *
 * The `{user}` placeholder in templates is substituted with req.user after
 * `escapeDnValue()` sanitization, to prevent DN-injection.
 */
import fs from 'fs';

import type { Config } from '../../config/args';
import type { DmRequest } from '../../lib/auth/base';
import { escapeDnValue } from '../../lib/utils';

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

  constructor(config: Config) {
    const fallback = config.ldap_base || '';
    this.defaultUserBase = (config.scim_user_base as string) || fallback;
    this.defaultGroupBase = (config.scim_group_base as string) || fallback;
    this.userTemplate = (config.scim_user_base_template as string) || '';
    this.groupTemplate = (config.scim_group_base_template as string) || '';

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

  private resolve(
    kind: 'user' | 'group',
    req?: DmRequest | { user?: string }
  ): string {
    const user =
      req && typeof req === 'object' && 'user' in req ? req.user : undefined;

    // 1. Explicit map entry
    if (this.map && user && this.map[user]) {
      const entry = this.map[user];
      if (kind === 'user' && entry.userBase) return entry.userBase;
      if (kind === 'group' && entry.groupBase) return entry.groupBase;
    }
    // 2. Wildcard map entry
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
