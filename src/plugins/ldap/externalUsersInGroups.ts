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
import { declaredMailDomains } from '../../lib/mailDomains';
import {
  launchHooks,
  launchHooksChained,
  normalizeDn,
  parseDn,
  unescapeDnValue,
} from '../../lib/utils';

/**
 * The domain of an address, as the managed domains are compared: after its
 * last `@` (the local part may hold one, quoted), lower-cased, without the
 * trailing dot DNS allows. Empty for an address without one.
 */
export const mailDomainOf = (mail: string): string => {
  const at = mail.lastIndexOf('@');
  return at < 1
    ? ''
    : mail
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
};

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
      // Read once per group write, and only when an external member is new
      let managed: Promise<string[]> | undefined;
      // Parallelize member validation/creation with global concurrency limit
      await Promise.all(
        members.map(m =>
          this.server.ldap.queryLimit(async () => {
            const mail = this.externalAddress(m);
            if (mail === null) return false;

            try {
              // Check if member exists (will use cache with scope: 'base')
              // As the server: the group write was judged first; its external members are the server's bookkeeping
              await this.ldap.system.search({ paged: false, scope: 'base' }, m);
              return true;
            } catch {
              // Member doesn't exist, create it
              if (!mail) throw new Error(`Malformed member ${m}`);

              const domain = mailDomainOf(mail);
              if (!domain) throw new Error(`Malformed member ${m}`);
              managed ??= this.managedDomains();
              if ((await managed).includes(domain)) {
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
                // As the server: the group write was judged first; its external members are the server's bookkeeping
                await this.ldap.system.add(m, entry);
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

  /**
   * The domains no external member may use, lower-cased: those of
   * `--mail-domain` and those the directory declares in its domain branches,
   * the ones `core/twake/james` follows. A deployment declaring its domains
   * in the directory only would otherwise take an address of its own for an
   * external one, and so would a client reading the list from `/config`.
   *
   * A subdomain of a managed domain is not managed: it is external unless
   * declared itself.
   */
  async managedDomains(): Promise<string[]> {
    return [
      ...new Set([
        ...this.configuredDomains(),
        ...(await declaredMailDomains(this.server)),
      ]),
    ];
  }

  /** `--mail-domain`, lower-cased */
  private configuredDomains(): string[] {
    const configured = this.config.mail_domain;
    return Array.isArray(configured)
      ? configured.map(domain => String(domain).toLowerCase())
      : [];
  }

  /**
   * Where a client sends an external member: `mail=<escaped address>,<branch>`
   */
  async getConfigApiData(): Promise<Record<string, unknown>> {
    let managedDomains: string[];
    try {
      managedDomains = await this.managedDomains();
    } catch (err) {
      // The branch and the configured domains are still known: a client
      // keeps them while the directory does not answer. The creation itself
      // refuses an external member then.
      this.logger.warn(
        `${this.name}: the directory's mail domains could not be read: ${String(err)}`
      );
      managedDomains = this.configuredDomains();
    }
    return {
      enabled: true,
      branch: this.config.external_members_branch,
      rdnAttribute: 'mail',
      managedDomains,
    };
  }
}
