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
import { HttpError } from '../../lib/errors';
import ldapActions, { AttributesList } from '../../lib/ldapActions';
import {
  launchHooks,
  launchHooksChained,
  normalizeDn,
  parseDn,
  unescapeDnValue,
} from '../../lib/utils';

export default class ExternalUsersInGroups extends DmPlugin {
  name = 'externalUsersInGroups';
  roles: Role[] = ['consistency', 'configurable'] as const;

  dependencies = { ldapGroups: 'core/ldap/groups' };

  ldap: ldapActions;

  constructor(server: DM) {
    super(server);
    this.ldap = server.ldap;
  }

  hooks: Hooks = {
    ldapgroupvalidatemembers: async ([dn, members]) => {
      // Parallelize member validation/creation with global concurrency limit
      await Promise.all(
        members.map(m =>
          this.server.ldap.queryLimit(async () => {
            const mail = this.externalAddress(m);
            if (mail === null) return false;

            try {
              // Check if member exists (will use cache with scope: 'base')
              await this.ldap.search({ paged: false, scope: 'base' }, m);
              return true;
            } catch {
              // Member doesn't exist, create it
              if (!mail) throw new Error(`Malformed member ${m}`);

              const domain = mail.split('@')[1]?.toLowerCase();
              if (domain && this.managedDomains().includes(domain)) {
                throw new Error(
                  `Cannot create external user with managed domain: ${mail}`
                );
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
                if (e instanceof HttpError) throw e;
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

  /**
   * The address of an external member, unescaped: the value of a `mail` RDN
   * right under the branch. Null for any other member.
   */
  externalAddress(member: string): string | null {
    const branch = this.config.external_members_branch;
    if (!branch) return null;
    const [rdn, ...parent] = parseDn(member);
    if (!rdn || normalizeDn(parent.join(',')) !== normalizeDn(branch))
      return null;
    const eq = rdn.indexOf('=');
    if (eq < 0 || rdn.slice(0, eq).trim().toLowerCase() !== 'mail') return null;
    // An unescaped `+` joins a second attribute to the RDN
    const value = rdn.slice(eq + 1).trim();
    if (/(^|[^\\])(\\\\)*\+/.test(value)) return null;
    return unescapeDnValue(value);
  }

  /** `--mail-domain`, lower-cased: the domains no external member may use */
  managedDomains(): string[] {
    const domains = this.config.mail_domain;
    return Array.isArray(domains)
      ? domains.map(domain => String(domain).toLowerCase())
      : [];
  }

  /**
   * Where a client sends an external member: `mail=<escaped address>,<branch>`
   */
  getConfigApiData(): Record<string, unknown> {
    return {
      enabled: true,
      branch: this.config.external_members_branch,
      mainAttribute: 'mail',
      managedDomains: this.managedDomains(),
    };
  }
}
