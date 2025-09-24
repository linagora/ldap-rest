/**
 * @plugin core/externalUsersInGroups
 * @description Creates on-the-fly missing group users into a branch
 * This permits to add external users into mailing lists
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import { Hooks } from '../hooks';
import ldapActions, { AttributesList } from '../lib/ldapActions';
import { launchHooks, launchHooksChained } from '../lib/utils';

export default class ExternalUsersInGroups extends DmPlugin {
  name = 'externalUsersInGroups';

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
                .catch(async () => {
                  const mail = m.replace(/^mail=([^,]+),.*$/, '$1');
                  if (!mail) return reject(new Error(`Malformed member ${m}`));
                  let entry: AttributesList = {
                    objectClass: this.config.user_class as string[],
                    mail,
                    [this.config.ldap_groups_main_attribute as string]: mail,
                    sn: mail,
                  };
                  [m, entry] = await launchHooksChained(
                    this.registeredHooks.externaluserentry,
                    [m, entry]
                  );
                  this.ldap
                    .add(m, entry)
                    .then(() => {
                      void launchHooks(
                        this.registeredHooks.externaluseradded,
                        m,
                        entry
                      );
                      resolve(true);
                    })
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
