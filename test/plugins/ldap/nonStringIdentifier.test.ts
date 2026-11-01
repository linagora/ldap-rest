/**
 * The identifier of a creation body is a string. A number, a boolean, an
 * array or an object — what a form parser gives for `uid[a]=b` — reached the
 * DN escaping, threw a `TypeError` and was answered 500, where the client
 * deserves a 400 naming the attribute (#556).
 */
import { expect } from 'chai';
import supertest from 'supertest';
import { DM } from '../../../src/bin';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import LdapGroups from '../../../src/plugins/ldap/groups';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('A creation body naming the entry', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let base: string;
  let previousGroupSchema: string | undefined;
  const people = '/api/v1/ldap/falsyPeople';
  const groups = '/api/v1/ldap/groups';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    base = process.env.DM_LDAP_BASE as string;
    // This is about the identifier's type, not about the schema's patterns,
    // and the suite that follows expects the default back
    previousGroupSchema = process.env.DM_GROUP_SCHEMA;
    process.env.DM_GROUP_SCHEMA = '';
    server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = [
      './test/fixtures/schemas/falsyPeople.json',
    ];
    server.config.ldap_group_base = `ou=lists,ou=groups,${base}`;
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    await server.registerPlugin('core/ldap/groups', new LdapGroups(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(async () => {
    if (previousGroupSchema === undefined) delete process.env.DM_GROUP_SCHEMA;
    else process.env.DM_GROUP_SCHEMA = previousGroupSchema;
    await server?.stop();
  });

  for (const body of [{ uid: 1 }, { uid: true }, { uid: ['a'] }]) {
    it(`answers 400 for ${JSON.stringify(body)}`, async () => {
      const res = await request.post(people).send(body);
      expect(res.status, JSON.stringify(res.body)).to.equal(400);
      expect(res.body.error).to.match(/uid must be a string/);
    });
  }

  it('answers 400 for an identifier a form body gives as an object', async () => {
    // A form body `uid[a]=b` is parsed as `{"uid":{"a":"b"}}`
    const res = await request.post(people).type('form').send('uid[a]=b');
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/uid must be a string/);
  });

  it('answers 400 for a group name that is not a string', async () => {
    const res = await request.post(groups).send({ cn: 1, member: [] });
    expect(res.status, JSON.stringify(res.body)).to.equal(400);
    expect(res.body.error).to.match(/cn must be a string/);
  });

  it('creates the entry a string names', async () => {
    // The check is on the type, not on the value: a name is still a name
    const res = await request
      .post(people)
      .send({ uid: '1', cn: 'One', sn: 'O' });
    expect(res.status, JSON.stringify(res.body)).to.equal(201);
    await server.ldap.delete(`uid=1,ou=users,${base}`).catch(() => undefined);
  });
});
