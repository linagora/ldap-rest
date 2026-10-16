/**
 * A JSON number or boolean is written as text where the schema declares one,
 * on a creation as on a modify: the creation paths validate a copy of the
 * entry and write another.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Numbers and booleans on a creation', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let person: string;
  let group: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    person = `uid=numeric.alice,ou=users,${base}`;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/numericPeople.json',
    ];
    server.config.group_schema = './test/fixtures/schemas/numericGroups.json';
    server.config.group_class = ['top', 'groupOfNames', 'posixGroup'];
    group = `cn=numeric-guild,${server.config.ldap_group_base}`;
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('ldapGroups', new LdapGroups(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  beforeEach(async () => {
    for (const dn of [person, group])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  after(async () => {
    for (const dn of [person, group])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  const read = async (
    dn: string,
    attributes: string[]
  ): Promise<Record<string, unknown>> => {
    const res = (await server.ldap.search(
      { paged: false, scope: 'base', attributes },
      dn
    )) as SearchResult;
    return res.searchEntries[0];
  };

  it('should write the numbers and the boolean of a flat entity', async () => {
    const res = await request.post('/api/v1/ldap/numericPeople').send({
      uid: 'numeric.alice',
      cn: 'Numeric Alice',
      sn: 'Alice',
      uidNumber: 4242,
      gidNumber: 4242,
      homeDirectory: '/home/numeric.alice',
      pwdReset: true,
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect(
      await read(person, ['uidNumber', 'gidNumber', 'pwdReset'])
    ).to.include({ uidNumber: '4242', gidNumber: '4242', pwdReset: 'TRUE' });
  });

  it('should write the number of a group', async () => {
    const res = await request
      .post('/api/v1/ldap/groups')
      .send({ cn: 'numeric-guild', gidNumber: 4243 });
    expect(res.status, JSON.stringify(res.body)).to.be.oneOf([200, 201]);
    expect(await read(group, ['gidNumber'])).to.include({
      gidNumber: '4243',
    });
  });
});
