import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

describe('SCIM Groups (integration)', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  let groupBase: string;
  let savedUserBase: string | undefined;
  let savedGroupBase: string | undefined;

  before(async function () {
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn('Skipping SCIM Groups tests: LDAP env vars missing');
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    userBase = `ou=users,${baseDn}`;
    groupBase = `ou=groups,${baseDn}`;
    savedUserBase = process.env.DM_SCIM_USER_BASE;
    savedGroupBase = process.env.DM_SCIM_GROUP_BASE;
    process.env.DM_SCIM_USER_BASE = userBase;
    process.env.DM_SCIM_GROUP_BASE = groupBase;
    server = new DM();
    plugin = new Scim(server);
    await plugin.api(server.app);
    await server.ready;

    try {
      await plugin.ldap.add(`uid=scim-groupuser,${userBase}`, {
        objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        cn: 'Group User',
        sn: 'User',
        uid: 'scim-groupuser',
      });
    } catch {
      /* may already exist */
    }
  });

  after(async () => {
    if (plugin) {
      try {
        await plugin.ldap.delete(`uid=scim-groupuser,${userBase}`);
      } catch {
        /* ignore */
      }
    }
    if (savedUserBase === undefined) delete process.env.DM_SCIM_USER_BASE;
    else process.env.DM_SCIM_USER_BASE = savedUserBase;
    if (savedGroupBase === undefined) delete process.env.DM_SCIM_GROUP_BASE;
    else process.env.DM_SCIM_GROUP_BASE = savedGroupBase;
  });

  afterEach(async () => {
    if (!plugin) return;
    for (const id of ['scim-testgroup', 'scim-othergroup']) {
      try {
        await plugin.ldap.delete(`cn=${id},${groupBase}`);
      } catch {
        /* ignore */
      }
    }
  });

  it('creates a Group', async () => {
    const res = await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
        members: [{ value: 'scim-groupuser' }],
      })
      .expect(201);
    expect(res.body.id).to.equal('scim-testgroup');
    expect(res.body.displayName).to.equal('scim-testgroup');
    expect(res.body.members).to.have.lengthOf.at.least(1);
  });

  it('gets a Group by id with SCIM member refs', async () => {
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
        members: [{ value: 'scim-groupuser' }],
      })
      .expect(201);
    const res = await supertest(server.app)
      .get('/scim/v2/Groups/scim-testgroup')
      .expect(200);
    const user = res.body.members?.find(
      (m: { value: string }) => m.value === 'scim-groupuser'
    );
    expect(user, 'group should include the scim-groupuser member').to.exist;
    expect(user.type).to.equal('User');
  });

  it('PATCH adds a member', async () => {
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
      })
      .expect(201);
    const res = await supertest(server.app)
      .patch('/scim/v2/Groups/scim-testgroup')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          {
            op: 'add',
            path: 'members',
            value: [{ value: 'scim-groupuser' }],
          },
        ],
      })
      .expect(200);
    const found = (res.body.members as { value: string }[] | undefined)?.some(
      m => m.value === 'scim-groupuser'
    );
    expect(found).to.be.true;
  });

  it('PATCH removes a member by value filter', async () => {
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
        members: [{ value: 'scim-groupuser' }],
      })
      .expect(201);
    await supertest(server.app)
      .patch('/scim/v2/Groups/scim-testgroup')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'remove', path: 'members[value eq "scim-groupuser"]' },
        ],
      })
      .expect(200);
    const res = await supertest(server.app)
      .get('/scim/v2/Groups/scim-testgroup')
      .expect(200);
    const hasUser = (res.body.members as { value: string }[] | undefined)?.some(
      m => m.value === 'scim-groupuser'
    );
    expect(hasUser).to.not.be.true;
  });

  it('filters groups by displayName eq', async () => {
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
      })
      .expect(201);
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-othergroup',
      })
      .expect(201);
    const res = await supertest(server.app)
      .get(
        '/scim/v2/Groups?filter=' +
          encodeURIComponent('displayName eq "scim-testgroup"')
      )
      .expect(200);
    expect(res.body.totalResults).to.equal(1);
    expect(res.body.Resources[0].displayName).to.equal('scim-testgroup');
  });

  it('DELETE removes the Group', async () => {
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
      })
      .expect(201);
    await supertest(server.app)
      .delete('/scim/v2/Groups/scim-testgroup')
      .expect(204);
    await supertest(server.app)
      .get('/scim/v2/Groups/scim-testgroup')
      .expect(404);
  });
});
