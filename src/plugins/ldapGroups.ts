/*
 * Plugin to manage groups into LDAP server
 *
 * - add/delete groups
 * - add/delete members of groups
 * - detect user deletion to remove them from groups (hook)
 *
 * Configuration options (can be set via CLI or env variables):
 * --ldap-group-base / DM_LDAP_GROUP_BASE : base DN where groups are stored
 * --group-class / DM_GROUP_CLASSES : object classes to use for groups (default: top, groupOfNames)
 *
 * Hooks used:
 * - ldapdeleterequest: to catch user deletion and remove them from all groups
 */

import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import type { Hooks } from '../hooks';
import type ldapActions from '../lib/ldapActions';
import { SearchResult } from '../lib/ldapActions';

export default class LdapGroups extends DmPlugin {
  name = 'ldapGroups';
  base?: string;
  ldap: ldapActions;

  constructor(server: DM) {
    super(server);
    this.ldap = server.ldap;
    this.base = this.config.ldap_group_base as string;
    if (!this.base) {
      this.base = this.config.ldap_base;
      console.warn(`LDAP group base is not defined, using "${this.base}"`);
    }
    if (!this.base) {
      throw new Error('LDAP base is not defined, please set --ldap-group-base');
    }
  }

  /*
    Catch all deletion to remove deleted users from groups
   */
  hooks: Hooks = {
    ldapdeleterequest: dn => {
      let _dn = dn;
      if (!Array.isArray(_dn)) {
        _dn = [_dn];
      }
      // Use async to delete user from groups, don't block the main deletion
      Promise.all(_dn.map(dnEntry => this.deleteMemberFromAll(dnEntry))).catch(
        err => {
          console.error('Failed to process user deletion in groups:', err);
        }
      );
      return dn;
    },
  };

  async addGroup(cn: string, members: string[] = []): Promise<boolean> {
    let dn: string;
    if (/^cn=/.test(cn)) {
      dn = cn;
      cn = cn.replace(/^cn=([^,]+).*$/, '$1');
    } else {
      dn = `cn=${cn},${this.base}`;
    }
    // const dn = /,/.test(cn) ? cn : `cn=${cn},${this.base}`;
    let entry = {
      objectClass: this.config.group_class as string[],
      cn,
      member: members.length ? members : ['cn=dummy'], // LDAP groupOfNames must have at least one member
    };
    if (this.registeredHooks.ldapgroupadd) {
      for (const func of this.registeredHooks.ldapgroupadd) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        if (func) [dn, entry] = await func([dn, entry]);
      }
    }
    return await this.ldap.add(dn, entry).catch(err => {
      throw new Error(`Failed to add group ${dn}: ${err}`);
    });
  }

  async deleteGroup(cn: string): Promise<boolean> {
    const dn = /,/.test(cn) ? cn : `cn=${cn},${this.base}`;
    return await this.ldap.delete(dn).catch(err => {
      throw new Error(`Failed to delete group ${dn}: ${err}`);
    });
  }

  async addMember(cn: string, member: string): Promise<boolean> {
    const dn = /,/.test(cn) ? cn : `cn=${cn},${this.base}`;
    if (this.registeredHooks.ldapgroupaddmember) {
      for (const func of this.registeredHooks.ldapgroupaddmember) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        if (func) [cn, member] = await func([cn, [member]]);
      }
    }
    return await this.ldap
      .modify(dn, {
        add: [{ member }],
      })
      .catch(err => {
        throw new Error(`Failed to add member ${member} to ${dn}: ${err}`);
      });
  }

  async deleteMember(cn: string, member: string): Promise<boolean> {
    const dn = /,/.test(cn) ? cn : `cn=${cn},${this.base}`;
    if (this.registeredHooks.ldapgroupdeletemember) {
      for (const func of this.registeredHooks.ldapgroupdeletemember) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        if (func) [cn, member] = await func([cn, [member]]);
      }
    }
    return await this.ldap
      .modify(dn, {
        delete: [{ member }],
      })
      .catch(err => {
        throw new Error(`Failed to delete member ${member} from ${dn}: ${err}`);
      });
  }

  async deleteMemberFromAll(memberDn: string): Promise<void> {
    const res = (await this.ldap
      .search(
        {
          filter: `member=${memberDn}`,
          paged: false,
          attributes: ['cn'],
        },
        this.base as string
      )
      .catch(err => {
        throw new Error(`Failed to search groups from ${this.base}: ${err}`);
      })) as SearchResult;

    await Promise.all(
      res.searchEntries.map(entry =>
        this.ldap
          .modify(entry.dn, {
            delete: [{ member: memberDn }],
          })
          .catch(err => {
            console.error(
              `Failed to remove ${memberDn} from group ${entry.dn}:`,
              err
            );
          })
      )
    );
  }

  //
  async listGroups(): Promise<AsyncGenerator<SearchResult>> {
    let _res = (await this.ldap
      .search(
        {
          filter: '(objectClass=*)',
          // paged: false,
          attributes: ['cn'],
        },
        this.base as string
      )
      .catch(err => {
        throw new Error(`Failed to list groups from ${this.base}: ${err}`);
      })) as AsyncGenerator<SearchResult>;

    // let res = _res.searchEntries.map(entry => entry.cn as string);
    if (this.registeredHooks._ldapgrouplist) {
      for (const func of this.registeredHooks._ldapgrouplist) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        if (func) _res = await func(_res);
      }
    }
    return _res;
  }
}
