/**
 * A mail address written on an entry no entity covers is refused.
 *
 * The domain and uniqueness rules are declared by the entity schemas, so the
 * rules only judge entries that land in a branch one declares. An entry
 * written elsewhere — at the directory root, say, which no schema covers —
 * carries a mail address nothing checks, and the mail server provisions the
 * entry wherever it is.
 */
import type { Request } from 'express';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import { BadRequestError } from '../../../src/lib/errors';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapOrganizations from '../../../src/plugins/ldap/organizations';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Enterprise rules: entries no entity covers', function () {
  let base: string;
  let server: DM;
  // What a route hands the directory: the rule is about what a caller writes,
  // so the add and the modify below name one.
  const asCaller = {
    user: 'rules.admin',
    headers: {},
    method: 'POST',
    url: '/',
  } as unknown as Request;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    // The tree the rules are written for: the users branch is the only store
    // the schemas declare, and the organizations live under a branch of their
    // own, as they do in a deployment that sets --ldap-top-organization.
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    server.config.organization_schema =
      './static/schemas/twake/organizations.json';
    server.config.ldap_top_organization = `ou=organization,${base}`;
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapOrganizations',
      new LdapOrganizations(server)
    );
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
  });

  after(async () => {
    for (const dn of [
      `cn=rules.outside,${base}`,
      `uid=rules.inside,ou=users,${base}`,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  it('refuses a mail address at the directory root', async () => {
    try {
      await server.ldap.add(
        `cn=rules.outside,${base}`,
        {
          objectClass: ['top', 'inetOrgPerson'],
          cn: 'rules.outside',
          sn: 'Outside',
          mail: 'rules.outside@example.com',
        },
        asCaller
      );
      expect.fail('an address nothing checks was accepted');
    } catch (err) {
      expect(err).to.be.instanceOf(BadRequestError);
      expect((err as Error).message).to.match(/no entity covers/);
    }
  });

  it('refuses a mail address added later to such an entry', async () => {
    const dn = `cn=rules.outside,${base}`;
    await server.ldap.add(dn, {
      objectClass: ['top', 'inetOrgPerson'],
      cn: 'rules.outside',
      sn: 'Outside',
    });
    try {
      await server.ldap.modify(
        dn,
        { replace: { mail: 'rules.outside@example.com' } },
        asCaller
      );
      expect.fail('an address nothing checks was added to the entry');
    } catch (err) {
      expect(err).to.be.instanceOf(BadRequestError);
      expect((err as Error).message).to.match(/no entity covers/);
    }
  });

  it('still accepts an address in the branch its schema declares', async () => {
    await server.ldap.add(`uid=rules.inside,ou=users,${base}`, {
      objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
      uid: 'rules.inside',
      cn: 'rules.inside',
      sn: 'Inside',
      mail: 'rules.inside@example.com',
    });
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['mail'] },
      `uid=rules.inside,ou=users,${base}`
    )) as { searchEntries: Record<string, unknown>[] };
    expect(res.searchEntries[0]).to.have.property(
      'mail',
      'rules.inside@example.com'
    );
  });
});
