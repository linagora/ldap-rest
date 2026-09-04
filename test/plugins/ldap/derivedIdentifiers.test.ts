/**
 * The identifier is derived from the mail address, and the two charsets are
 * not the same one. A mail the schema's own `test` accepts must still produce
 * a usable `uid` — the client cannot repair it, since a generated attribute is
 * refused as input.
 *
 * And whatever the identifier ends up being, `apiAdd` re-reads the entry it
 * has just written by filtering on it.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Derived identifiers', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let deptDn: string;
  const positionCn = 'Directeur (Web) Front';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    deptDn = `ou=DerivedOrg,${base}`;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './static/schemas/twake/users.json',
      './static/schemas/example/positions.json',
    ];
    await server.ldap
      .add(deptDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'DerivedOrg',
        twakeDepartmentPath: 'DerivedOrg',
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
      `uid=johntag,ou=users,${base}`,
      `cn=${positionCn},ou=positions,${base}`,
      deptDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  it('should derive an identifier from a mail the schema accepts', async () => {
    // `john+tag@example.com` passes the schema's own mail test; the `+` is
    // not in the uid charset, so the derivation has to drop it rather than
    // produce a value the very next check refuses.
    const res = await request.post('/api/v1/ldap/users').type('json').send({
      cn: 'John Tag',
      sn: 'Tag',
      mail: 'john+tag@example.com',
      twakeDepartmentLink: deptDn,
      employeeNumber: 'DER0001',
      givenName: 'Test',
      displayName: 'Test Person',
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    const found = (await server.ldap.search(
      { paged: false, scope: 'base', filter: '(objectClass=*)' },
      `uid=johntag,ou=users,${base}`
    )) as { searchEntries: Record<string, unknown>[] };
    expect(found.searchEntries).to.have.length(1);
  });

  it('should re-read an identifier carrying filter metacharacters', async () => {
    // The position schema admits parentheses. Interpolated raw into the
    // search-back filter they made it unparseable — after the entry was
    // committed, so the caller got a 500 on a creation that had worked and a
    // retry then hit a duplicate DN.
    const res = await request
      .post('/api/v1/ldap/positions')
      .type('json')
      .send({ cn: positionCn });
    expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
  });
});
