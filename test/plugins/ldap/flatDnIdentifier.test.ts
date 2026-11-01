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
import { normalizeDn } from '../../../src/lib/utils';
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

  it('answers 400 for a DN value with an escape RFC 4514 does not define', async () => {
    // The DN keeps the escape while the name is decoded: the directory
    // would refuse it, or store an entry its own spelling does not name
    const dn = `uid=uid=${B}q${B}x,ou=users,${base}`;
    const res = await request.post(route).send({ uid: dn, cn: 'Q', sn: 'Q' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/escape RFC 4514/);
    expect((await stored(dn)).searchEntries).to.deep.equal([]);
    expect(
      (await stored(`uid=qx,ou=users,${base}`)).searchEntries
    ).to.deep.equal([]);
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

  it('writes the name the directory folds the RDN to', async () => {
    // `uid=\ zoë` and `uid=zoë` are one name for the directory: the entry is
    // written under the folded one, with that value, and the other spelling
    // is refused as taken instead of creating a second entry
    const folded = `uid=zoë,ou=users,${base}`;
    const first = await request
      .post(route)
      .send({ uid: `uid=${B} zoë,ou=users,${base}`, cn: 'Zoë', sn: 'Z' });
    expect(first.status, JSON.stringify(first.body)).to.equal(201);
    const written = await stored(folded);
    expect(written.searchEntries[0]?.dn).to.equal(folded);
    expect(written.searchEntries[0]?.uid).to.equal('zoë');

    const second = await request
      .post(route)
      .send({ uid: folded, cn: 'Zoë', sn: 'Z' });
    expect(second.status, JSON.stringify(second.body)).to.equal(409);
    await server.ldap.delete(folded).catch(() => undefined);
  });

  it('writes the composed name for a decomposed one', async () => {
    // NFKC: the two are one name to the directory, and the composed one is
    // what the entry carries
    const composed = `uid=café,ou=users,${base}`;
    const res = await request
      .post(route)
      .send({ uid: `uid=cafe\u0301,ou=users,${base}`, cn: 'Café', sn: 'C' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect((await stored(composed)).searchEntries[0]?.uid).to.equal('café');

    const second = await request
      .post(route)
      .send({ uid: composed, cn: 'Café', sn: 'C' });
    expect(second.status, JSON.stringify(second.body)).to.equal(409);
    await server.ldap.delete(composed).catch(() => undefined);
  });

  it('writes the value a quoted RDN holds, without the quotes', async () => {
    // LDAPv2 quotes one value: `uid="a+b"` names `a+b`, and the entry is
    // written under the DN that spells it that way, so it can be read back
    const dn = `uid=a${B}+b,ou=users,${base}`;
    const res = await request
      .post(route)
      .send({ uid: `uid="a+b",ou=users,${base}`, cn: 'Quoted', sn: 'Q' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    expect(res.body.uid).to.equal('a+b');
    // The directory spells `+` in hex; the DN is the one written
    expect(normalizeDn(res.body.dn as string)).to.equal(normalizeDn(dn));
    expect((await stored(dn)).searchEntries[0]?.uid).to.equal('a+b');
    await server.ldap.delete(dn).catch(() => undefined);
  });
});
