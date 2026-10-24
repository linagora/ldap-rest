/**
 * @module lib/mailDomains
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * The mail domains a directory declares: entries in the domain branches,
 * each naming its domain in an attribute.
 * @group Libraries
 */
import type { DM } from '../bin';
import { type Schema, roleAttribute } from '../config/schema';

import { getLogger } from './expressFormatedResponses';
import { extractLdapCode } from './ldapCodes';
import type { SearchResult } from './ldapActions';

/** Where mail domain entries live, and the attribute naming their domain */
export interface DomainBranch {
  base: string;
  attribute: string;
}

// The test of the shipped twakeDomain.json, lower-cased: `*`, which the
// enterprise rules read as "every domain allowed", is no mail domain
const FQDN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The mail domains among values, lower-cased as James stores them */
export const mailDomains = (values: string[] | undefined): string[] => [
  ...new Set(
    (values ?? []).map(v => v.trim().toLowerCase()).filter(v => FQDN.test(v))
  ),
];

/**
 * Where the mail domain entries live, and the attribute naming their
 * domain: each loaded flat schema declaring the `domainName` role, the
 * lookup `core/ldap/enterpriseRules` makes. Without one, the branch of the
 * shipped `twake/nomenclature/twakeDomain.json` and the attribute
 * `--enterprise-domain-name-attribute` names.
 *
 * Rebuilt on each call, as the enterprise rules do theirs: a list taken in
 * a constructor could predate the schemas.
 *
 * @param server the server, whose flat entities are read
 * @returns the domain branches
 */
export function domainBranches(server: DM): DomainBranch[] {
  const flat = server.loadedPlugins['ldapFlatGeneric'] as
    | { instances?: { base: string; schema?: Schema }[] }
    | undefined;
  const branches: DomainBranch[] = [];
  for (const instance of flat?.instances || []) {
    const attribute = roleAttribute(instance.schema, 'domainName');
    if (attribute) branches.push({ base: instance.base, attribute });
  }
  if (branches.length || !server.config.ldap_base) return branches;
  return [
    {
      base: `ou=domains,ou=nomenclature,${server.config.ldap_base}`,
      attribute:
        server.config.enterprise_domain_name_attribute || 'associatedDomain',
    },
  ];
}

/**
 * Every mail domain the domain branches declare, lower-cased.
 *
 * Read as the server: which domains the directory serves is not a matter of
 * who asks. A branch that does not exist declares none; any other failure
 * is thrown, since an answer missing domains reads as "not ours".
 *
 * @param server the server
 * @returns the declared domains, each once
 */
export async function declaredMailDomains(server: DM): Promise<string[]> {
  const domains: string[] = [];
  for (const { base, attribute } of domainBranches(server)) {
    try {
      // Paged: a branch past the server's size limit would otherwise fail,
      // and every write needing the list with it
      const pages = (await server.ldap.system.search(
        {
          paged: { pageSize: 500 },
          scope: 'sub',
          filter: `(${attribute}=*)`,
          attributes: [attribute],
        },
        base
      )) as AsyncGenerator<SearchResult>;
      for await (const page of pages)
        for (const entry of page.searchEntries || [])
          // The directory answers the attribute in its own case
          for (const [name, value] of Object.entries(entry))
            if (name.toLowerCase() === attribute.toLowerCase())
              domains.push(...[value].flat().map(String));
    } catch (err) {
      if (extractLdapCode(err) !== 32) throw err;
      // A deployment may keep no domain branch; a mistyped base reads the
      // same, so it is said
      getLogger()?.debug(`No mail domain branch at ${base}`);
    }
  }
  return mailDomains(domains);
}
