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
  let savedLockAttr: string | undefined;
  let savedLockValue: string | undefined;

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
    // The test directory has no ppolicy overlay, so pwdAccountLockedTime is
    // not in its schema. Back SCIM `active` with an inetOrgPerson attribute
    // the mapping does not otherwise use.
    savedLockAttr = process.env.DM_SCIM_USER_LOCK_ATTRIBUTE;
    savedLockValue = process.env.DM_SCIM_USER_LOCK_VALUE;
    process.env.DM_SCIM_USER_LOCK_ATTRIBUTE = 'employeeType';
    process.env.DM_SCIM_USER_LOCK_VALUE = 'disabled';
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
    if (savedLockAttr === undefined)
      delete process.env.DM_SCIM_USER_LOCK_ATTRIBUTE;
    else process.env.DM_SCIM_USER_LOCK_ATTRIBUTE = savedLockAttr;
    if (savedLockValue === undefined)
      delete process.env.DM_SCIM_USER_LOCK_VALUE;
    else process.env.DM_SCIM_USER_LOCK_VALUE = savedLockValue;
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
      // RFC 7644 section 3.1: a create answers with the Location header.
      // No --scim-base-url here, so it is the prefix-relative form: the
      // absolute one would carry the client's own Host header.
      expect(res.headers.location).to.equal('/scim/v2/Users/scim-alice');
      expect(res.headers.location).to.not.match(/^https?:/);
    });

    it('sends Location on PUT and PATCH too', async () => {
      await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);
      const put = await supertest(server.app)
        .put('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Smith' },
        })
        .expect(200);
      expect(put.headers.location).to.match(/\/scim\/v2\/Users\/scim-alice$/);
      const patch = await supertest(server.app)
        .patch('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'displayName', value: 'X' }],
        })
        .expect(200);
      expect(patch.headers.location).to.match(/\/scim\/v2\/Users\/scim-alice$/);
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
      // RFC 7643 section 2.3.5: meta.created/lastModified are xsd:dateTime,
      // not the directory's GeneralizedTime.
      expect(res.body.meta.created).to.match(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/
      );
      expect(Date.parse(res.body.meta.created)).to.be.a('number').and.not.NaN;
      expect(res.body.meta.lastModified).to.match(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/
      );
      expect(Date.parse(res.body.meta.lastModified)).to.be.a('number').and.not
        .NaN;
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
      await supertest(server.app).get('/scim/v2/Users/scim-alice').expect(404);
    });
  });

  describe('Location with a pinned base URL', () => {
    let pinnedServer: DM;
    let pinnedPlugin: Scim;
    let savedBaseUrl: string | undefined;

    before(async () => {
      savedBaseUrl = process.env.DM_SCIM_BASE_URL;
      process.env.DM_SCIM_BASE_URL = 'https://scim.example.test';
      pinnedServer = new DM();
      pinnedPlugin = new Scim(pinnedServer);
      await pinnedPlugin.api(pinnedServer.app);
      await pinnedServer.ready;
    });

    after(async () => {
      try {
        await pinnedPlugin.ldap.delete(`uid=scim-alice,${userBase}`);
      } catch {
        /* ignore */
      }
      if (savedBaseUrl === undefined) delete process.env.DM_SCIM_BASE_URL;
      else process.env.DM_SCIM_BASE_URL = savedBaseUrl;
    });

    it('is absolute, and built from the flag rather than the Host header', async () => {
      const res = await supertest(pinnedServer.app)
        .post('/scim/v2/Users')
        .set('Host', 'attacker.example')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);
      expect(res.headers.location).to.equal(
        'https://scim.example.test/scim/v2/Users/scim-alice'
      );
      expect(res.headers.location).to.not.match(/attacker/);
    });
  });

  describe('active (RFC 7643 section 4.1.1)', () => {
    const create = (body: Record<string, unknown>) =>
      supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
          ...body,
        });

    it('defaults to active on create', async () => {
      const res = await create({}).expect(201);
      expect(res.body.active).to.be.true;
    });

    it('creates a deactivated user', async () => {
      const res = await create({ active: false }).expect(201);
      expect(res.body.active).to.be.false;
      const got = await supertest(server.app)
        .get('/scim/v2/Users/scim-alice')
        .expect(200);
      expect(got.body.active).to.be.false;
    });

    it('PATCH replace active=false deactivates, active=true reactivates', async () => {
      await create({}).expect(201);
      const off = await supertest(server.app)
        .patch('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        })
        .expect(200);
      expect(off.body.active).to.be.false;

      const on = await supertest(server.app)
        .patch('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        })
        .expect(200);
      expect(on.body.active).to.be.true;
    });

    it('reactivating an already active user is a no-op, not a 500', async () => {
      await create({}).expect(201);
      const res = await supertest(server.app)
        .patch('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: true }],
        })
        .expect(200);
      expect(res.body.active).to.be.true;
    });

    it('deactivates through a PATCH with no path', async () => {
      await create({}).expect(201);
      const res = await supertest(server.app)
        .patch('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', value: { active: false } }],
        })
        .expect(200);
      expect(res.body.active).to.be.false;
    });

    it('PUT leaves the lock alone unless the body speaks about it', async () => {
      await create({ active: false }).expect(201);
      // A profile-sync PUT that never mentions `active` must not release a
      // lock it knows nothing about — the directory may own it (a ppolicy
      // auto-lockout, an administrator's hand).
      const silent = await supertest(server.app)
        .put('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(200);
      expect(silent.body.active).to.be.false;

      // Saying so explicitly does reactivate.
      const on = await supertest(server.app)
        .put('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
          active: true,
        })
        .expect(200);
      expect(on.body.active).to.be.true;

      const off = await supertest(server.app)
        .put('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
          active: false,
        })
        .expect(200);
      expect(off.body.active).to.be.false;
    });

    it('reads the string form on POST and PUT, not only on PATCH', async () => {
      // `active: "false"` used to miss the strict `=== false` test, so POST
      // created an enabled account and PUT deleted the lock attribute —
      // a deactivation executed as a reactivation, answering 200.
      const created = await create({ active: 'false' }).expect(201);
      expect(created.body.active).to.be.false;

      const put = await supertest(server.app)
        .put('/scim/v2/Users/scim-alice')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
          active: 'false',
        })
        .expect(200);
      expect(put.body.active).to.be.false;
    });

    it('refuses a value it cannot read, on POST, PUT and PATCH alike', async () => {
      for (const value of ['0', 'no', 42, null]) {
        const res = await create({ active: value }).expect(400);
        expect(res.body.scimType).to.equal('invalidValue');
      }

      await create({}).expect(201);
      for (const value of ['0', 'no', 42, null]) {
        const put = await supertest(server.app)
          .put('/scim/v2/Users/scim-alice')
          .set('Content-Type', 'application/scim+json')
          .send({
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'scim-alice',
            name: { familyName: 'Doe' },
            active: value,
          })
          .expect(400);
        expect(put.body.scimType).to.equal('invalidValue');

        const patch = await supertest(server.app)
          .patch('/scim/v2/Users/scim-alice')
          .set('Content-Type', 'application/scim+json')
          .send({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value }],
          })
          .expect(400);
        expect(patch.body.scimType).to.equal('invalidValue');
      }

      // And the account is untouched by any of it.
      const got = await supertest(server.app)
        .get('/scim/v2/Users/scim-alice')
        .expect(200);
      expect(got.body.active).to.be.true;
    });

    it('filters on active', async () => {
      await create({ active: false }).expect(201);
      const inactive = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('active eq false'))
        .expect(200);
      const ids = inactive.body.Resources.map((r: { id: string }) => r.id);
      expect(ids).to.include('scim-alice');

      const activeOnly = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('active eq true'))
        .expect(200);
      const activeIds = activeOnly.body.Resources.map(
        (r: { id: string }) => r.id
      );
      expect(activeIds).to.not.include('scim-alice');
    });

    it('answers "active pr" instead of sending an undefined attribute', async () => {
      await create({}).expect(201);
      const res = await supertest(server.app)
        .get('/scim/v2/Users?filter=' + encodeURIComponent('active pr'))
        .expect(200);
      const ids = res.body.Resources.map((r: { id: string }) => r.id);
      expect(ids).to.include('scim-alice');
    });
  });

  describe('attributes / excludedAttributes (RFC 7644 section 3.9)', () => {
    beforeEach(async () => {
      await supertest(server.app)
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
    });

    it('narrows a single resource', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users/scim-alice?attributes=userName')
        .expect(200);
      expect(Object.keys(res.body).sort()).to.deep.equal([
        'id',
        'schemas',
        'userName',
      ]);
    });

    it('narrows to a sub-attribute', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users/scim-alice?attributes=name.familyName')
        .expect(200);
      expect(res.body.name).to.deep.equal({ familyName: 'Doe' });
    });

    it('excludes from a single resource', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users/scim-alice?excludedAttributes=emails,name')
        .expect(200);
      expect(res.body).to.not.have.property('emails');
      expect(res.body).to.not.have.property('name');
      expect(res.body.userName).to.equal('scim-alice');
      expect(res.body.id).to.equal('scim-alice');
    });

    it('narrows every resource of a list', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users?attributes=userName')
        .expect(200);
      expect(res.body.schemas[0]).to.equal(
        'urn:ietf:params:scim:api:messages:2.0:ListResponse'
      );
      for (const r of res.body.Resources) {
        expect(Object.keys(r).sort()).to.deep.equal([
          'id',
          'schemas',
          'userName',
        ]);
      }
    });

    it('narrows the answer to a create', async () => {
      await supertest(server.app)
        .delete('/scim/v2/Users/scim-alice')
        .expect(204);
      const res = await supertest(server.app)
        .post('/scim/v2/Users?attributes=userName')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(201);
      expect(Object.keys(res.body).sort()).to.deep.equal([
        'id',
        'schemas',
        'userName',
      ]);
      // The Location header is built before the projection, so it survives.
      expect(res.headers.location).to.match(/\/Users\/scim-alice$/);
    });

    it('refuses both parameters on a write before it happens', async () => {
      // The check used to run while building the answer, so the entry was
      // created and the caller still read a 400 — a provisioner would record
      // the user as not provisioned while it existed in the directory.
      await supertest(server.app)
        .delete('/scim/v2/Users/scim-alice')
        .expect(204);
      await supertest(server.app)
        .post('/scim/v2/Users?attributes=userName&excludedAttributes=emails')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-alice',
          name: { familyName: 'Doe' },
        })
        .expect(400);
      // Nothing must have been written.
      await supertest(server.app).get('/scim/v2/Users/scim-alice').expect(404);
    });

    it('refuses both parameters at once', async () => {
      const res = await supertest(server.app)
        .get(
          '/scim/v2/Users/scim-alice?attributes=userName&excludedAttributes=emails'
        )
        .expect(400);
      expect(res.body.scimType).to.equal('invalidValue');
    });
  });

  describe('a lock attribute the directory does not know', () => {
    let badServer: DM;
    let badPlugin: Scim;
    const savedBad: Record<string, string | undefined> = {};

    before(async () => {
      // The shipped default, pwdAccountLockedTime, only exists when slapd
      // loads the ppolicy overlay — this test directory does not, which is
      // the common default deployment shape.
      for (const k of [
        'DM_SCIM_USER_LOCK_ATTRIBUTE',
        'DM_SCIM_USER_LOCK_VALUE',
      ])
        savedBad[k] = process.env[k];
      delete process.env.DM_SCIM_USER_LOCK_ATTRIBUTE;
      delete process.env.DM_SCIM_USER_LOCK_VALUE;
      badServer = new DM();
      badPlugin = new Scim(badServer);
      await badPlugin.api(badServer.app);
      await badServer.ready;
    });

    after(async () => {
      try {
        await badPlugin.ldap.delete(`uid=scim-bob,${userBase}`);
      } catch {
        /* ignore */
      }
      for (const [k, v] of Object.entries(savedBad)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('answers a SCIM error naming the cause, not a bare 500', async () => {
      const res = await supertest(badServer.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim-bob',
          name: { familyName: 'Doe' },
          active: false,
        })
        .expect(400);
      expect(res.body.scimType).to.equal('invalidValue');
      expect(res.body.detail).to.match(/--scim-user-lock-attribute/);
      expect(res.body.schemas[0]).to.equal(
        'urn:ietf:params:scim:api:messages:2.0:Error'
      );
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
        .get(
          '/scim/v2/Users?filter=' +
            encodeURIComponent('userName eq "scim-alice"')
        )
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
