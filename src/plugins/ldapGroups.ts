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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    super(server);
    this.base = this.config.ldap_group_base as string;
    this.ldap = server.ldap;
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
      if (!Array.isArray(dn)) {
        dn = [dn];
      }
      dn.forEach(dnEntry => {
        this.ldap
          .search(
            { filter: `member: ${dnEntry}`, paged: false, attributes: [] },
            this.base
          )
          .then(results => {
            (results as SearchResult).searchEntries.forEach(entry => {
              this.ldap
                .modify(entry.dn, {
                  delete: [{ member: dnEntry }],
                })
                .catch(err => {
                  console.error(
                    `Failed to remove deleted ${dnEntry} from group ${entry.dn}:`,
                    err
                  );
                });
            });
          })
          .catch(err => {
            console.error(
              `Failed to search for groups containing deleted user ${dnEntry}:`,
              err
            );
          });
      });
      return dn;
    },
  };
}
