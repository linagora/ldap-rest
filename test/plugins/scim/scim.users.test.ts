import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

describe('SCIM Users (integration)', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  let savedUserBase: string | undefined;
  let savedGroupBase: string | undefined;

  before(async function () {
    // setup.ts populates DM_LDAP_* env vars via mocha root beforeAll hook
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn('Skipping SCIM integration tests: LDAP env vars missing');
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    userBase = `ou=users,${baseDn}`;
    // Snapshot env before mutating so we can restore in `after`.
    savedUserBase = process.env.DM_SCIM_USER_BASE;
    savedGroupBase = process.env.DM_SCIM_GROUP_BASE;
    process.env.DM_SCIM_USER_BASE = userBase;
    process.env.DM_SCIM_GROUP_BASE = `ou=groups,${baseDn}`;
    server = new DM();
    plugin = new Scim(server);
    await plugin.api(server.app);
    await server.ready;
  });

  after(() => {
    if (savedUserBase === undefined) delete process.env.DM_SCIM_USER_BASE;
    else process.env.DM_SCIM_USER_BASE = savedUserBase;
    if (savedGroupBase === undefined) delete process.env.DM_SCIM_GROUP_BASE;
    else process.env.DM_SCIM_GROUP_BASE = savedGroupBase;
  });

  afterEach(async () => {
    if (!plugin) return;
    for (const id of ['scim-alice', 'scim-bob']) {
      try {
        await plugin.ldap.delete(`uid=${id},${userBase}`);
      } catch {
        /* ignore */
      }
    }
  });

  describe('ServiceProviderConfig', () => {
    it('advertises capabilities', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/ServiceProviderConfig')
        .expect(200);
      expect(res.headers['content-type']).to.match(/application\/scim\+json/);
      expect(res.body.schemas[0]).to.equal(
        'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'
      );
      expect(res.body.patch.supported).to.be.true;
      expect(res.body.bulk.supported).to.be.true;
      expect(res.body.filter.supported).to.be.true;
    });
  });

  describe('ResourceTypes / Schemas', () => {
    it('lists ResourceTypes', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/ResourceTypes')
        .expect(200);
      expect(res.body.totalResults).to.equal(2);
      const ids = res.body.Resources.map((r: { id: string }) => r.id);
      expect(ids).to.have.members(['User', 'Group']);
    });
    it('lists Schemas with User + Group', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Schemas')
        .expect(200);
      expect(res.body.totalResults).to.equal(2);
    });
  });

  describe('Users CRUD', () => {
    it('creates a User via POST', async () => {
      const res = await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe', givenName: 'Alice' },
          displayName: 'Alice D.',
          emails: [{ value: 'alice@example.com', primary: true }],
        })
        .expect(201);
      expect(res.body.id).to.equal('scim-alice');
      expect(res.body.userName).to.equal('scim-alice');
      expect(res.body.meta.resourceType).to.equal('User');
      expect(res.body.emails[0].value).to.equal('alice@example.com');
    });

    it('rejects duplicate User with 409', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);
      const res = await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(409);
      expect(res.body.scimType).to.equal('uniqueness');
    });

    it('gets a User by id', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);
      const res = await supertest(server.app)
        .get('/scim/v2/Users/scim-alice')
        .expect(200);
      expect(res.body.userName).to.equal('scim-alice');
    });

    it('returns 404 in SCIM envelope for unknown User', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users/doesnotexist')
        .expect(404);
      expect(res.body.schemas[0]).to.equal(
        'urn:ietf:params:scim:api:messages:2.0:Error'
      );
      expect(res.body.status).to.equal('404');
    });

    it('PATCH replaces displayName', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
          displayName: 'Old',
        })
        .expect(201);
      const res = await supertest(server.app)
        .patch('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            { op: 'replace', path: 'displayName', value: 'Alice Doe' },
          ],
        })
        .expect(200);
      expect(res.body.displayName).to.equal('Alice Doe');
    });

    it('PUT replaces the User', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe', givenName: 'Alice' },
          displayName: 'Original',
        })
        .expect(201);
      const res = await supertest(server.app)
        .put('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Smith' },
          displayName: 'Replaced',
        })
        .expect(200);
      expect(res.body.displayName).to.equal('Replaced');
      expect(res.body.name.familyName).to.equal('Smith');
    });

    it('DELETE removes the User', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);
      await supertest(server.app)
        .delete('/scim/v2/Users/scim-alice')
        .expect(204);
      await supertest(server.app)
        .get('/scim/v2/Users/scim-alice')
        .expect(404);
    });
  });

  describe('Users list & filter', () => {
    beforeEach(async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe', givenName: 'Alice' },
          displayName: 'Alice',
        });
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-bob',
          name: { familyName: 'Smith', givenName: 'Bob' },
          displayName: 'Bob',
        });
    });

    it('filters by userName eq', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('userName eq "scim-alice"'))
        .expect(200);
      expect(res.body.totalResults).to.equal(1);
      expect(res.body.Resources[0].userName).to.equal('scim-alice');
    });

    it('filters by id eq (short-circuit)', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('id eq "scim-bob"'))
        .expect(200);
      expect(res.body.totalResults).to.equal(1);
      expect(res.body.Resources[0].id).to.equal('scim-bob');
    });

    it('paginates with startIndex & count', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users?startIndex=1&count=1')
        .expect(200);
      expect(res.body.itemsPerPage).to.equal(1);
      expect(res.body.startIndex).to.equal(1);
      expect(res.body.totalResults).to.be.at.least(2);
    });

    it('rejects invalid filter with SCIM envelope', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('nosuch eq "x"'))
        .expect(400);
      expect(res.body.scimType).to.equal('invalidFilter');
    });
  });
});
