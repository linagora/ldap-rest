/**
 * @module plugins/twake/groups
 *
 * Organization groups: `core/ldap/groups`, with one group branch per
 * organization. A group's members belong to its organization, whichever API
 * writes it, and a tombstone is hidden from the member lists it still holds.
 *
 * See `docs/usage/plugins/integrations/groups.md`.
 */
import type { DM } from '../../bin';
import type { Hooks } from '../../hooks';
import { BadRequestError } from '../../lib/errors';
import { extractLdapCode } from '../../lib/ldapCodes';
import type {
  AttributesList,
  AttributeValue,
  SearchResult,
} from '../../lib/ldapActions';
import {
  escapeDnValue,
  escapeLdapFilter,
  isDummyMemberDn,
  normalizeDn,
  parseDn,
  unescapeDnValue,
} from '../../lib/utils';
import LdapGroups from '../ldap/groups';

import {
  lifecycleAttributes,
  type LifecycleAttributes,
} from './lifecycleAttributes';

const ORG = '{org}';

/** The values of an attribute, whatever shape the directory gave them. */
export function values(value: AttributeValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(v => v.toString());
}

/** A DN spelled one way, to compare two spellings of it. */
function dnKey(dn: string): string {
  try {
    return normalizeDn(dn);
  } catch {
    return dn.toLowerCase();
  }
}

function parentOf(dn: string): string {
  return parseDn(dn).slice(1).join(',');
}

export default class TwakeGroups extends LdapGroups {
  name = 'twakeGroups';

  protected readonly groupBase: string;
  protected readonly userBase: string;
  protected readonly groupPattern: RegExp;
  protected readonly attrs: LifecycleAttributes;

  constructor(server: DM) {
    super(server);
    this.groupBase = this.config.twake_group_base || '';
    this.userBase = this.config.twake_group_user_base || '';
    for (const [option, pattern] of [
      ['--twake-group-base', this.groupBase],
      ['--twake-group-user-base', this.userBase],
    ])
      if (!pattern.includes(ORG))
        throw new Error(`${this.name}: ${option} must hold ${ORG}`);
    // The organization is one RDN value: `(?:\\.|[^,])+` keeps an escaped
    // comma inside it.
    const [before, after] = parseDn(this.groupBase)
      .join(',')
      .split(ORG)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.groupPattern = new RegExp(
      `^${before}(?<org>(?:\\\\.|[^,])+)${after}$`,
      'i'
    );
    this.attrs = lifecycleAttributes(this.config);
  }

  /**
   * No `ldapdeletedone`: an erased member leaves its groups through the
   * directory's referential integrity, whatever made the delete. The cleanup
   * inherited from core/ldap/groups writes through LDAP-Rest, so every group
   * would announce a member removed on an erase, which publishes nothing.
   */
  hooks: Hooks = {
    ldapaddrequest: ([dn, entry, req]) => {
      this.checkMembers(dn, entry.member);
      return [dn, entry, req];
    },
    ldapmodifyrequest: ([dn, changes, op, req]) => {
      this.checkMembers(dn, changes.add?.member);
      this.checkMembers(dn, changes.replace?.member);
      return [dn, changes, op, req];
    },
    ldapsearchfilter: async ([result, req, opts]) => [
      await this.hideTombstones(result),
      req,
      opts,
    ],
  };

  /** The organization a group DN belongs to, if it is a group at all. */
  organizationOf(dn: string): string | undefined {
    const spelled = parseDn(dn).join(',');
    const m = this.groupPattern.exec(parentOf(spelled));
    return m?.groups ? unescapeDnValue(m.groups.org) : undefined;
  }

  groupBaseOf(org: string): string {
    return this.groupBase.replace(ORG, escapeDnValue(org));
  }

  userBaseOf(org: string): string {
    return this.userBase.replace(ORG, escapeDnValue(org));
  }

  /**
   * A group's members belong to its organization, as a provider is trusted
   * within its own organization only. The placeholder belongs to none.
   */
  private checkMembers(dn: string, members: AttributeValue | undefined): void {
    const org = this.organizationOf(dn);
    if (!org) return;
    const users = dnKey(this.userBaseOf(org));
    for (const member of values(members)) {
      if (isDummyMemberDn(member, this.config.group_dummy_user)) continue;
      if (dnKey(parentOf(member)) !== users)
        throw new BadRequestError(
          `${member} is not a user of organization ${org}`
        );
    }
  }

  /**
   * A tombstone keeps its memberships until it is erased, and is hidden from
   * them, so every API reads the same member list.
   */
  private async hideTombstones(result: SearchResult): Promise<SearchResult> {
    if (!this.attrs.deleted) return result;
    const orgs = new Set<string>();
    for (const entry of result.searchEntries) {
      const org = this.organizationOf(entry.dn);
      if (org && entry.member !== undefined) orgs.add(org);
    }
    if (orgs.size === 0) return result;
    const hidden = new Set<string>();
    for (const org of orgs)
      for (const dn of await this.tombstonesOf(org)) hidden.add(dnKey(dn));
    if (hidden.size === 0) return result;
    return {
      ...result,
      searchEntries: result.searchEntries.map(entry =>
        entry.member === undefined || !this.organizationOf(entry.dn)
          ? entry
          : {
              ...entry,
              member: values(entry.member).filter(m => !hidden.has(dnKey(m))),
            }
      ),
    };
  }

  private async tombstonesOf(org: string): Promise<string[]> {
    const { deleted, deletedValue } = this.attrs;
    try {
      const { searchEntries } = (await this.ldap.search(
        {
          paged: false,
          scope: 'one',
          filter: `(${deleted}=${escapeLdapFilter(deletedValue)})`,
          attributes: ['dn'],
        },
        this.userBaseOf(org)
      )) as SearchResult;
      return searchEntries.map(e => e.dn);
    } catch (err) {
      if (extractLdapCode(err) === 32) return [];
      throw err;
    }
  }
}
