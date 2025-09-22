/**
 * This plugin creates missing group users into a branch.
 * This permits to add external users into mailing lists
 */

import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import { Hooks } from '../hooks';
import ldapActions, { AttributesList } from '../lib/ldapActions';

export default class TwakeExternalUsersInGroups extends DmPlugin {
  name = 'twakeExternalUsersInGroups';

  dependencies = { ldapGroups: 'core/ldapGroups' };

  ldap: ldapActions;

  constructor(server: DM) {
    super(server);
    this.ldap = server.ldap;
  }

  hooks: Hooks = {
    ldapgroupvalidatemembers: async ([dn, members]) => {
      await Promise.all(
        members
          .map(m => m.replace(/\s/g, ''))
          .map(m => {
            return new Promise((resolve, reject) => {
              if (
                !new RegExp(
                  `mail=([^,]+),${this.config.external_members_branch}$`
                ).test(m)
              )
                return resolve(false);
              this.ldap
                .search({ paged: false }, m)
                .then(resolve)
                .catch(() => {
                  const mail = m.replace(/^mail=([^,]+),.*$/, '$1');
                  if (!mail) return reject(new Error(`Malformed member ${m}`));
                  const entry: AttributesList = {
                    objectClass: this.config.user_class as string[],
                    mail,
                    cn: mail,
                    sn: mail,
                  };
                  this.ldap
                    .add(m, entry)
                    .then(resolve)
                    .catch(e =>
                      reject(new Error(`Unable to insert ${m}: ${e}`))
                    );
                });
            });
          })
      );
      return [dn, members];
    },
  };
}
