import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

const SEARCH = 'urn:ietf:params:scim:api:messages:2.0:SearchRequest';

describe('SCIM POST /.search', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = {};

  before(async function () {
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    userBase = `ou=users,${baseDn}`;
    Object.assign(env, {
      DM_SCIM_USER_BASE: userBase,
      DM_SCIM_GROUP_BASE: `ou=groups,${baseDn}`,
      DM_SCIM_USER_LOCK_ATTRIBUTE: 'employeeType',
      DM_SCIM_USER_LOCK_VALUE: 'disabled',
    });
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    server = new DM();
    plugin = new Scim(server);
    plugin.api(server.app);
    await server.ready;
    for (const [uid, given] of [
      ['scim-search-a', 'Ann'],
      ['scim-search-b', 'Bea'],
    ]) {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: uid,
          name: { familyName: 'Searched', givenName: given },
        })
        .expect(201);
    }
  });

  after(async () => {
    if (plugin) {
      for (const uid of ['scim-search-a', 'scim-search-b']) {
        try {
          await plugin.ldap.delete(`uid=${uid},${userBase}`);
        } catch {
          /* ignore */
        }
      }
    }
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const search = (body: unknown, type = 'application/scim+json') =>
    supertest(server.app)
      .post('/scim/v2/Users/.search')
      .set('Content-Type', type)
      .send(body as object);

  it('answers what the GET list answers for the same query', async () => {
    const filter = 'name.familyName eq "Searched"';
    const get = await supertest(server.app)
      .get('/scim/v2/Users')
      .query({ filter, attributes: 'userName' })
      .expect(200);
    const post = await search({
      schemas: [SEARCH],
      filter,
      attributes: ['userName'],
    }).expect(200);
    expect(post.headers['content-type']).to.match(/application\/scim\+json/);
    expect(post.body.totalResults).to.equal(2);
    expect(post.body).to.deep.equal(get.body);
  });

  it('pages with startIndex and count', async () => {
    const res = await search({
      schemas: [SEARCH],
      filter: 'name.familyName eq "Searched"',
      startIndex: 2,
      count: 1,
    }).expect(200);
    expect(res.body.totalResults).to.equal(2);
    expect(res.body.startIndex).to.equal(2);
    expect(res.body.Resources).to.have.length(1);
  });

  it('applies excludedAttributes', async () => {
    const res = await search({
      filter: 'userName eq "scim-search-a"',
      excludedAttributes: ['name'],
    }).expect(200);
    expect(res.body.Resources[0].userName).to.equal('scim-search-a');
    expect(res.body.Resources[0]).to.not.have.property('name');
  });

  it('accepts a body without schemas, as application/json', async () => {
    const res = await search(
      { filter: 'userName eq "scim-search-b"' },
      'application/json'
    ).expect(200);
    expect(res.body.totalResults).to.equal(1);
  });

  it('refuses another message schema', async () => {
    const res = await search({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    }).expect(400);
    expect(res.body.scimType).to.equal('invalidSyntax');
  });

  it('refuses ill-typed members', async () => {
    await search({ count: '1' }).expect(400);
    await search({ attributes: 'userName' }).expect(400);
    await search({ filter: 42 }).expect(400);
  });

  it('answers invalidFilter for a bad filter', async () => {
    const res = await search({ filter: 'userName eq' }).expect(400);
    expect(res.body.scimType).to.equal('invalidFilter');
  });

  it('searches groups too', async () => {
    await supertest(server.app)
      .post('/scim/v2/Groups/.search')
      .set('Content-Type', 'application/scim+json')
      .send({ schemas: [SEARCH], count: 1 })
      .expect(200);
  });
});
