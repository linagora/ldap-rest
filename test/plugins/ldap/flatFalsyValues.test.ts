/**
 * An empty string is a value on the flat routes, as on groups and
 * organizations: checked against the pattern, and for a pointer against its
 * branch, never stored as an empty attribute.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Falsy values on the flat routes', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  const route = '/api/v1/ldap/falsyPeople';
  const dn = (): string => `uid=falsy-alice,ou=users,${base}`;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/falsyPeople.json',
    ];
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  beforeEach(async () => {
    await server.ldap.add(dn(), {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'falsy-alice',
      cn: 'Alice',
      sn: 'Falsy',
      mail: 'alice@example.org',
    });
  });

  afterEach(async () => {
    await server.ldap.delete(dn()).catch(() => undefined);
  });

  const stored = async (attribute: string): Promise<unknown> => {
    const result = (await server.ldap.search(
      { paged: false, scope: 'base', attributes: [attribute] },
      dn()
    )) as SearchResult;
    return result.searchEntries[0]?.[attribute];
  };

  for (const attribute of ['mail', 'manager'] as const) {
    it(`refuses an empty ${attribute} on a modify`, async () => {
      const res = await request
        .put(`${route}/falsy-alice`)
        .send({ replace: { [attribute]: '' } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(new RegExp(attribute));
      expect(await stored('mail')).to.equal('alice@example.org');
    });

    it(`refuses an empty ${attribute} on a creation`, async () => {
      const res = await request.post(route).send({
        uid: 'falsy-bob',
        cn: 'Bob',
        sn: 'Falsy',
        [attribute]: '',
      });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(new RegExp(attribute));
    });
  }

  for (const [attribute, value] of [
    ['secretary', ''],
    ['seeAlso', ['']],
  ] as const) {
    it(`refuses ${JSON.stringify(value)} for ${attribute}, a pointer with no branch`, async () => {
      const res = await request
        .put(`${route}/falsy-alice`)
        .send({ replace: { [attribute]: value } });
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(
        new RegExp(`${attribute}.*must point to a DN`)
      );
      expect(await stored(attribute)).to.deep.equal([]);
    });
  }

  it('names an empty required attribute as missing on a creation', async () => {
    const res = await request
      .post(route)
      .send({ uid: 'falsy-bob', cn: 'Bob', sn: '' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/"sn" is required/);
  });

  it('still accepts a value matching the pattern', async () => {
    const res = await request
      .put(`${route}/falsy-alice`)
      .send({ replace: { employeeNumber: '42' } });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(await stored('employeeNumber')).to.equal('42');
  });
});
