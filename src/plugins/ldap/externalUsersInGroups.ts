/**
 * @module plugins/ldap/externalUsersInGroups
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Creates on-the-fly missing group users into a branch
 * This permits to add external users into mailing lists
 */
import DmPlugin, { type Role } from '../../abstract/plugin';
import type { DM } from '../../bin';
import { Hooks } from '../../hooks';
import ldapActions, { AttributesList } from '../../lib/ldapActions';
import { launchHooks, launchHooksChained } from '../../lib/utils';

export default class ExternalUsersInGroups extends DmPlugin {
  name = 'externalUsersInGroups';
  roles: Role[] = ['consistency'] as const;

  dependencies = { ldapGroups: 'core/ldap/ldapGroups' };

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

                  // Check if mail domain is in managed domains
                  if (
                    this.config.mail_domain &&
                    Array.isArray(this.config.mail_domain)
                  ) {
                    const domain = mail.split('@')[1];
                    if (domain && this.config.mail_domain.includes(domain)) {
                      return reject(
                        new Error(
                          `Cannot create external user with managed domain: ${mail}`
                        )
                      );
                    }
                  }

                  let entry: AttributesList = {
                    objectClass: (this.config.external_branch_class ||
                      this.config.user_class) as string[],
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
