/**
 * `POST /v1/ldap/{resource}/{id}/rename` — the route itself and what it
 * refuses.
 *
 * An administrator may change a user's identifier after the fact. The value
 * is still the schema's to accept: a rename used to go through
 * `validateDnValue` alone, which knows about control characters and about
 * emptiness and nothing about the pattern the very same value had to match
 * to be created.
 *
 * The body field is `newId` for every entity, as `/move`'s is `targetOrgDn`
 * for every entity: the flat OpenAPI is written once for `{resource}` and
 * cannot document a field named after each instance's main attribute.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapEnterpriseRules from '../../../src/plugins/ldap/enterpriseRules';
import type {
  AttributesList,
  SearchResult,
} from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Flat entity rename', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let orgDn: string;
  let userBranch: string;
  const ALICE = 'rn.alice';
  const BOB = 'rn.bob';
  const POSITION = 'Rename Officer';

  const userEntry = (uid: string, employeeNumber: string): AttributesList => ({
    objectClass: ['top', 'twakeAccount', 'twakeWhitePages'],
    uid,
    cn: uid,
    sn: 'Rename',
    givenName: 'Test',
    displayName: `Test ${uid}`,
    mail: `${uid}@example.com`,
    employeeNumber,
    twakeDepartmentLink: orgDn,
    twakeDepartmentPath: 'RenameOrg',
    twakeAccountStatus: `cn=active,ou=twakeAccountStatus,ou=nomenclature,${base}`,
    twakeDeliveryMode: [
      `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,${base}`,
    ],
  });

  const read = async (dn: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = (await server.ldap.search(
        { paged: false, scope: 'base' },
        dn
      )) as SearchResult;
      return (res.searchEntries[0] as Record<string, unknown>) || null;
    } catch {
      return null;
    }
  };

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    userBranch = `ou=users,${base}`;
    orgDn = `ou=RenameOrg,${base}`;

    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './static/schemas/twake/users.json',
      './static/schemas/example/positions.json',
    ];
    // The placeholder is a configuration value, not an entry: the guard has
    // to recognise it without the directory holding anything.
    server.config.group_dummy_user = `uid=fakeuser,${userBranch}`;

    await server.ldap
      .add(orgDn, {
        objectClass: ['top', 'organizationalUnit', 'twakeDepartment'],
        ou: 'RenameOrg',
        twakeDepartmentPath: 'RenameOrg',
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
      `uid=${ALICE},${userBranch}`,
      `uid=${ALICE}2,${userBranch}`,
      `uid=${BOB},${userBranch}`,
      `cn=${POSITION},ou=positions,${base}`,
      orgDn,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
  });

  beforeEach(async () => {
    for (const dn of [
      `uid=${ALICE},${userBranch}`,
      `uid=${ALICE}2,${userBranch}`,
      `uid=${BOB},${userBranch}`,
    ])
      await server.ldap.delete(dn).catch(() => undefined);
    await server.ldap.add(
      `uid=${ALICE},${userBranch}`,
      userEntry(ALICE, 'RNM0001')
    );
    await server.ldap.add(
      `uid=${BOB},${userBranch}`,
      userEntry(BOB, 'RNM0002')
    );
  });

  const rename = (id: string, body: unknown): supertest.Test =>
    request
      .post(`/api/v1/ldap/users/${encodeURIComponent(id)}/rename`)
      .type('json')
      .send(body as object);

  it('should rename the entry and answer its new DN', async () => {
    const res = await rename(ALICE, { newId: `${ALICE}2` });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.deep.equal({
      success: true,
      dn: `uid=${ALICE}2,${userBranch}`,
      referencesUpdated: 0,
    });

    expect((await request.get(`/api/v1/ldap/users/${ALICE}`)).status).to.equal(
      404
    );
    const after = await request.get(`/api/v1/ldap/users/${ALICE}2`);
    expect(after.status).to.equal(200);
    expect(after.body.dn).to.equal(`uid=${ALICE}2,${userBranch}`);
  });

  it('should leave the identifier single-valued, with no trace of the old one', async () => {
    // `modifyDN` keeps the old RDN value as an ordinary attribute value
    // unless it is told to drop it. A `uid` holding both names is not a
    // renamed account, it is an account answering to two identifiers.
    await rename(ALICE, { newId: `${ALICE}2` });
    const entry = await read(`uid=${ALICE}2,${userBranch}`);
    expect(entry?.uid).to.equal(`${ALICE}2`);
  });

  it('should refuse a value the schema refuses, and say what a good one looks like', async () => {
    await request
      .post('/api/v1/ldap/positions')
      .type('json')
      .send({ cn: POSITION });
    const res = await request
      .post(`/api/v1/ldap/positions/${encodeURIComponent(POSITION)}/rename`)
      .type('json')
      .send({ newId: 'Bad  Officer!' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    // The hint travels with the pattern, so the caller is told what to send.
    expect(res.body.error).to.match(/Letters, spaces and/);
  });

  it('should refuse an empty identifier', async () => {
    const res = await rename(ALICE, { newId: '' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
  });

  it('should refuse control characters', async () => {
    const res = await rename(ALICE, { newId: 'bo\u0001b' });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/control characters/);
  });

  it('should refuse a body without newId', async () => {
    const res = await rename(ALICE, {});
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
  });

  it('should refuse a newId that is not a string', async () => {
    const res = await rename(ALICE, { newId: 42 });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/newId/);
  });

  it('should refuse a full DN where a value is expected', async () => {
    const res = await rename(ALICE, {
      newId: `uid=${ALICE}2,${userBranch}`,
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/not a DN/);
  });

  it('should refuse an identifier already taken, leaving the source alone', async () => {
    const res = await rename(ALICE, { newId: BOB });
    expect(res.status, JSON.stringify(res.body)).to.equal(409);
    expect(await read(`uid=${ALICE},${userBranch}`)).to.not.equal(null);
    expect((await read(`uid=${BOB},${userBranch}`))?.employeeNumber).to.equal(
      'RNM0002'
    );
  });

  it('should refuse attributes sent beside newId', async () => {
    // Ignoring it would leave the caller believing it had set the path.
    const res = await rename(ALICE, {
      newId: `${ALICE}2`,
      twakeDepartmentPath: '/elsewhere',
    });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/twakeDepartmentPath/);
    expect(await read(`uid=${ALICE},${userBranch}`)).to.not.equal(null);
  });

  it('should still refuse the identifier as an attribute of a modify', async () => {
    // `generated` is about attribute names in a payload. A dedicated endpoint
    // taking a `newId` does not make the attribute writable.
    const res = await request
      .put(`/api/v1/ldap/users/${ALICE}`)
      .type('json')
      .send({ replace: { uid: BOB } });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(await read(`uid=${ALICE},${userBranch}`)).to.not.equal(null);
  });

  it('should accept the identifier it already has, as a repair does', async () => {
    const res = await rename(ALICE, { newId: ALICE });
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.deep.equal({
      success: true,
      dn: `uid=${ALICE},${userBranch}`,
      referencesUpdated: 0,
    });
    expect(await read(`uid=${ALICE},${userBranch}`)).to.not.equal(null);
  });

  it('should answer 404 for an entry that is not there', async () => {
    const res = await rename('rn.nobody', { newId: 'rn.nobodyelse' });
    expect(res.status, JSON.stringify(res.body)).to.equal(404);
    expect(res.body.error).to.match(/user not found/);
  });

  it('should refuse to rename the configured placeholder member', async () => {
    // The placeholder lives in the configuration. Renaming it would leave
    // `isDummyMemberDn` naming something else, and every empty group would
    // then refuse to be deleted.
    const res = await rename('fakeuser', { newId: 'realuser' });
    expect(res.status, JSON.stringify(res.body)).to.equal(409);
    expect(res.body.error).to.match(/placeholder member/);
  });

  it('should refuse to rename an entry onto the placeholder', async () => {
    const res = await rename(ALICE, { newId: 'fakeuser' });
    expect(res.status, JSON.stringify(res.body)).to.equal(409);
    expect(res.body.error).to.match(/placeholder member/);
  });

  it('should advertise the route with the rest of the resource', () => {
    const plugin = server.loadedPlugins['ldapFlatGeneric'] as LdapFlatGeneric;
    const data = plugin.getConfigApiData() as {
      flatResources: { pluralName: string; endpoints: { rename?: string } }[];
    };
    const users = data.flatResources.find(r => r.pluralName === 'users');
    expect(users?.endpoints.rename).to.equal('/api/v1/ldap/users/:id/rename');
  });
});
