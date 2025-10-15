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
      // Parallelize member validation/creation with global concurrency limit
      await Promise.all(
        members
          .map(m => m.replace(/\s/g, ''))
          .map(m =>
            this.server.ldap.queryLimit(async () => {
              if (
                !new RegExp(
                  `mail=([^,]+),${this.config.external_members_branch}$`
                ).test(m)
              )
                return false;

              try {
                // Check if member exists (will use cache with scope: 'base')
                await this.ldap.search({ paged: false, scope: 'base' }, m);
                return true;
              } catch {
                // Member doesn't exist, create it
                const mail = m.replace(/^mail=([^,]+),.*$/, '$1');
                if (!mail) throw new Error(`Malformed member ${m}`);

                // Check if mail domain is in managed domains
                if (
                  this.config.mail_domain &&
                  Array.isArray(this.config.mail_domain)
                ) {
                  const domain = mail.split('@')[1];
                  if (domain && this.config.mail_domain.includes(domain)) {
                    throw new Error(
                      `Cannot create external user with managed domain: ${mail}`
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

                try {
                  await this.ldap.add(m, entry);
                  void launchHooks(
                    this.registeredHooks.externaluseradded,
                    m,
                    entry
                  );
                  return true;
                } catch (e) {
                  throw new Error(
                    `Unable to insert ${m}: ${e instanceof Error ? e.message : String(e)}`
                  );
                }
              }
            })
          )
      );
      return [dn, members];
    },
  };
}
