/**
 * A flat entry created under a DN must answer for it: a DN whose value the
 * directory cannot take is a wrong request (400), not a server error, and a
 * DN the server cannot name an entry from is refused rather than written
 * back as a bare name.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { SearchResult } from 'ldapts';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

const B = String.fromCharCode(92);

describe('A flat entry created under a DN', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  const route = '/api/v1/ldap/falsyPeople';

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

  const stored = async (dn: string): Promise<SearchResult> => {
    try {
      return (await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['uid', 'cn'] },
        dn
      )) as SearchResult;
    } catch {
      // The directory holds no entry at that DN
      return { searchEntries: [] } as unknown as SearchResult;
    }
  };

  it('answers 400 for a name holding a control character', async () => {
    // The DN form skipped the check the bare-name form makes: the plain
    // Error it threw reached the client as a 500
    const res = await request
      .post(route)
      .send({ uid: `uid=bob${B}01,ou=users,${base}`, cn: 'Bob' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/control characters/);
  });

  it('answers 400 for an empty name', async () => {
    const res = await request
      .post(route)
      .send({ uid: `uid=,ou=users,${base}`, cn: 'Bob', sn: 'B' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/non-empty/);
  });

  it('refuses a multi-valued RDN instead of writing it as a name', async () => {
    // Every required attribute is sent, and the message is checked: a 400
    // for a missing field would hide what this case is about
    const dn = `uid=a+cn=b,ou=users,${base}`;
    const res = await request.post(route).send({ uid: dn, cn: 'Bob', sn: 'B' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/must be a value, or a/);
    expect((await stored(dn)).searchEntries).to.deep.equal([]);
  });

  it('writes a name whose escapes the DN decodes to itself', async () => {
    const dn = `uid=caf${B}C3${B}A9,ou=users,${base}`;
    const res = await request
      .post(route)
      .send({ uid: dn, cn: 'Café', sn: 'C' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect((await stored(dn)).searchEntries[0]?.uid).to.equal('café');
    await server.ldap.delete(dn).catch(() => undefined);
  });

  it('writes the name as the DN spells it, spaces included', async () => {
    // The DN names " a c", and that is what the entry is written with: read
    // as `rdnValue` reads a name, it was written "a c" under a DN naming
    // " a c", an entry the directory does not find under its own DN
    const dn = `uid=${B} a c,ou=users,${base}`;
    const res = await request.post(route).send({ uid: dn, cn: 'A C', sn: 'C' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect((await stored(dn)).searchEntries[0]?.uid).to.equal(' a c');
    await server.ldap.delete(dn).catch(() => undefined);
  });

  it('writes the name the DN gives, escapes decoded', async () => {
    const dn = `uid=Smith${B},John,ou=users,${base}`;
    const res = await request
      .post(route)
      .send({ uid: dn, cn: 'John', sn: 'Smith' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    // The DN names "Smith,John": the uid is that name, and the DN rebuilt
    // from it is the one sent
    expect(
      (await stored(`uid=Smith${B},John,ou=users,${base}`)).searchEntries[0]
        ?.uid
    ).to.equal('Smith,John');
    await server.ldap.delete(dn).catch(() => undefined);
  });
});
