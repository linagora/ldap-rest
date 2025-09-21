/**
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

import { Entry } from 'ldapts';
import type { Express } from 'express';

import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import type { Hooks } from '../hooks';
import type ldapActions from '../lib/ldapActions';
import type {
  AttributeValue,
  ModifyRequest,
  SearchResult,
} from '../lib/ldapActions';
import {
  badRequest,
  jsonBody,
  tryMethod,
  wantJson,
} from '../lib/expressFormatedResponses';

interface postAdd {
  cn: string;
  [key: string]: AttributeValue;
}
type postModify = ModifyRequest;

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

  /**
   * Catch all deletion to remove deleted users from groups
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

  /**
   * API routes
   */

  api(app: Express): void {
    // Add group
    app.post('/api/v1/ldap/groups', async (req, res) => {
      // Verify it's an AJAX request
      if (!wantJson(req, res)) return;
      const body = jsonBody(req, res, 'cn') as postAdd | false;
      if (!body) return;
      const cn = body.cn;
      const members = body.member ? body.member : [];
      const additional: Record<string, AttributeValue> = Object.fromEntries(
        Object.entries(body).filter(
          ([key, _value]) => key !== 'cn' && key !== 'member'
        )
      );
      await tryMethod(res, this.addGroup.bind(this), cn, members, additional);
    });

    // Delete group
    app.delete('/api/v1/ldap/groups/:cn', async (req, res) => {
      if (!wantJson(req, res)) return;
      const cn = decodeURIComponent(req.params.cn);
      if (!cn) return badRequest(res, 'cn is required');
      await tryMethod(res, this.deleteGroup.bind(this), cn);
    });

    // Modify group
    app.put('/api/v1/ldap/groups/:cn', async (req, res) => {
      if (!wantJson(req, res)) return;
      const body = jsonBody(req, res) as postModify | false;
      if (!body) return;
      const dn = this.fixDn(decodeURIComponent(req.params.cn));
      if (!dn) return badRequest(res);
      await tryMethod(res, this.modifyGroup.bind(this), dn, body);
    });

    // Add member to group
    app.post('/api/v1/ldap/groups/:cn/members', async (req, res) => {
      if (!wantJson(req, res)) return;
      const cn = decodeURIComponent(req.params.cn);
      if (!cn) return badRequest(res, 'cn is required');
      const body = jsonBody(req, res, 'member') as {
        member: string | string[];
      };
      if (!body) return;
      await tryMethod(res, this.addMember.bind(this), cn, body.member);
    });

    // Delete member from group
    app.delete('/api/v1/ldap/groups/:cn/members/:member', async (req, res) => {
      if (!wantJson(req, res)) return;
      const cn = decodeURIComponent(req.params.cn);
      const member = decodeURIComponent(req.params.member);
      if (!cn || !member) {
        return badRequest(res, 'cn and member are required');
      }
      await tryMethod(res, this.deleteMember.bind(this), cn, member);
    });
  }

  /**
   * LDAP group methods
   */

  async searchGroupsByName(
    cn: string,
    partial = false,
    attributes: string[] = ['cn', 'member']
  ): Promise<Record<string, Entry>> {
    const filter = partial ? `(cn=*${cn}*)` : `(cn=${cn})`;
    const _res = (await this.ldap.search(
      {
        filter,
        paged: false,
        attributes,
      },
      this.base as string
    )) as SearchResult;
    const res: Record<string, Entry> = {};
    _res.searchEntries.map(entry => {
      const s = entry.cn as string;
      if (s) res[s] = entry;
      if (!Array.isArray(res[s].member))
        res[s].member = [res[s].member as string];
      res[s].member = (res[s].member as string[]).filter((m: string) => {
        return m !== 'cn=fakeuser';
      });
    });
    return res;
  }

  async addGroup(
    cn: string,
    members: string[] = [],
    additional: Record<string, AttributeValue> = {}
  ): Promise<boolean> {
    let dn: string;
    if (/^cn=/.test(cn)) {
      dn = cn;
      cn = cn.replace(/^cn=([^,]+).*$/, '$1');
    } else {
      dn = `cn=${cn},${this.base}`;
    }

    let entry = {
      objectClass: this.config.group_class as string[],
      cn,
      member: members.length ? ['cn=fakeuser', ...members] : ['cn=fakeuser'], // LDAP groupOfNames must have at least one member
      ...additional,
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

  async modifyGroup(
    cn: string,
    changes: {
      add?: Record<string, AttributeValue>[];
      replace?: Record<string, AttributeValue>;
      delete?: string[] | Record<string, AttributeValue>;
    }
  ): Promise<boolean> {
    let dn = /,/.test(cn) ? cn : `cn=${cn},${this.base}`;
    if (this.registeredHooks.ldapgroupmodify) {
      for (const func of this.registeredHooks.ldapgroupmodify) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        if (func) [dn, changes] = await func([dn, changes]);
      }
    }
    return await this.ldap.modify(dn, changes);
  }

  async deleteGroup(cn: string): Promise<boolean> {
    let dn = /,/.test(cn) ? cn : `cn=${cn},${this.base}`;
    if (this.registeredHooks.ldapgroupdelete) {
      for (const func of this.registeredHooks.ldapgroupdelete) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        if (func) dn = await func(dn);
      }
    }
    return await this.ldap.delete(dn);
  }

  async addMember(cn: string, member: string | string[]): Promise<boolean> {
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
        throw new Error(`Failed to add member(s) to ${dn}: ${err}`);
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
        delete: { member: member },
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
            delete: { member: memberDn },
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

  protected fixDn(dn: string): string | false {
    if (!dn) return false;
    return /,/.test(dn) ? dn : `cn=${dn},${this.base}`;
  }
}
