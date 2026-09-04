/**
 * An array declares the rules of its elements under `items`. The flat path
 * never read them, so `mailAlternateAddress` — which has carried an
 * `items.test` since v0.7.0 — accepted anything at all, and
 * `twakeDelegatedUsers` accepted a DN from any branch. The console's own form
 * refused both, and `groups` refused `items.test` server-side: the same rule
 * was enforced in three places out of four.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Element rules of an array attribute', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let deptDn: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    deptDn = `ou=ItemRulesOrg,${base}`;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    await server.ldap
      .add(deptDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'ItemRulesOrg',
        twakeDepartmentPath: 'ItemRulesOrg',
      })
      .catch(() => undefined);
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin(
      'ldapEnterpriseRules',
      new LdapEnterpriseRules(server)
    );
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    for (const dn of [
      `uid=itemrules,ou=users,${base}`,
      `uid=itemrulesa,ou=users,${base}`,
      `uid=itemrulesb,ou=users,${base}`,
      deptDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  // A mail of its own per case: the identifier is derived from it, and a
  // refusal that failed to refuse would otherwise leave an entry behind and
  // turn the next case into a uniqueness conflict rather than its own answer.
  const account = (
    local: string,
    extra: Record<string, unknown>
  ): Record<string, unknown> => ({
    cn: 'Item Rules',
    sn: 'Rules',
    mail: `${local}@example.com`,
    twakeDepartmentLink: deptDn,
    ...extra,
  });

  it('should refuse an element the item pattern does not accept', async () => {
    const res = await request
      .post('/api/v1/ldap/users')
      .type('json')
      .send(
        account('itemrulesa', { mailAlternateAddress: ['not an address'] })
      );
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(JSON.stringify(res.body)).to.contain('mailAlternateAddress');
  });

  it('should refuse a DN outside the branch its items name', async () => {
    const res = await request
      .post('/api/v1/ldap/users')
      .type('json')
      .send(
        account('itemrulesb', {
          twakeDelegatedUsers: [`cn=nobody,ou=groups,${base}`],
        })
      );
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(JSON.stringify(res.body)).to.contain('branches');
  });

  it('should accept the elements the schema does accept', async () => {
    const res = await request
      .post('/api/v1/ldap/users')
      .type('json')
      .send(
        account('itemrules', {
          mailAlternateAddress: ['item.rules@example.com'],
        })
      );
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
  });
});
