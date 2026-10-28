import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

describe('SCIM Bulk (integration)', function () {
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
      console.warn('Skipping SCIM Bulk tests: LDAP env vars missing');
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
  });

  after(() => {
    if (savedUserBase === undefined) delete process.env.DM_SCIM_USER_BASE;
    else process.env.DM_SCIM_USER_BASE = savedUserBase;
    if (savedGroupBase === undefined) delete process.env.DM_SCIM_GROUP_BASE;
    else process.env.DM_SCIM_GROUP_BASE = savedGroupBase;
  });

  afterEach(async () => {
    if (!plugin) return;
    for (const uid of ['bulk-u1', 'bulk-u2']) {
      try {
        await plugin.ldap.delete(`uid=${uid},${userBase}`);
      } catch {
        /* ignore */
      }
    }
    for (const cn of ['bulk-g1']) {
      try {
        await plugin.ldap.delete(`cn=${cn},${groupBase}`);
      } catch {
        /* ignore */
      }
    }
  });

  it('creates a user and a group in one request with bulkId ref', async () => {
    const res = await supertest(server.app)
      .post('/scim/v2/Bulk')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            bulkId: 'u1',
            path: '/Users',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'bulk-u1',
              name: { familyName: 'One' },
            },
          },
          {
            method: 'POST',
            bulkId: 'g1',
            path: '/Groups',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
              displayName: 'bulk-g1',
              members: [{ value: 'bulkId:u1' }],
            },
          },
        ],
      })
      .expect(200);

    expect(res.body.Operations).to.have.lengthOf(2);
    expect(res.body.Operations[0].status).to.equal('201');
    expect(res.body.Operations[1].status).to.equal('201');
    expect(res.body.Operations[1].location).to.match(/\/Groups\/bulk-g1$/);

    // Verify the group actually contains the user
    const group = await supertest(server.app)
      .get('/scim/v2/Groups/bulk-g1')
      .expect(200);
    const found = (group.body.members as { value: string }[] | undefined)?.some(
      m => m.value === 'bulk-u1'
    );
    expect(found, 'group should contain bulk-u1').to.be.true;
  });

  it('takes an application/json body past the default parser limit', async () => {
    // Over body-parser's 100kb default, under --scim-bulk-max-payload-size
    const res = await supertest(server.app)
      .post('/scim/v2/Bulk')
      .set('Content-Type', 'application/json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [],
        padding: 'x'.repeat(200000),
      });
    expect(res.status).to.not.equal(413);
  });

  it('answers 400 per operation to a malformed one, and to a body nested too deeply', async () => {
    let deep: unknown = { userName: 'x' };
    for (let i = 0; i < 100; i++) deep = { a: deep };
    const res = await supertest(server.app)
      .post('/scim/v2/Bulk')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          null,
          { method: 'POST', path: 1, data: {} },
          { method: 'POST', path: '/Users' },
          { method: 'POST', path: '/Users', data: deep },
        ],
      })
      .expect(200);
    expect(
      res.body.Operations.map((o: { status: string }) => o.status)
    ).to.deep.equal(['400', '400', '400', '400']);
    // Built by hand: the serializer of the test client would overflow first.
    // Whether the server's does depends on the Node version: either the
    // whole request is refused, or that operation is; never a 500.
    const deeper = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000);
    const overflow = await supertest(server.app)
      .post('/scim/v2/Bulk')
      .set('Content-Type', 'application/scim+json')
      .send(
        '{"schemas":["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],' +
          `"Operations":[{"method":"POST","path":"/Users","data":${deeper}}]}`
      );
    expect([200, 400]).to.include(overflow.status);
    if (overflow.status === 400) {
      expect(overflow.body.scimType).to.equal('invalidValue');
    } else {
      expect(overflow.body.Operations[0].status).to.equal('400');
      expect(overflow.body.Operations[0].response.scimType).to.equal(
        'invalidValue'
      );
    }
  });

  it('honors failOnErrors', async () => {
    const res = await supertest(server.app)
      .post('/scim/v2/Bulk')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        failOnErrors: 1,
        Operations: [
          {
            method: 'POST',
            path: '/Users',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              // userName missing → triggers invalidValue
              name: { familyName: 'X' },
            },
          },
          {
            method: 'POST',
            path: '/Users',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'bulk-u2',
              name: { familyName: 'Two' },
            },
          },
        ],
      })
      .expect(200);

    // With failOnErrors=1, after the first error the second op must not run
    expect(res.body.Operations).to.have.lengthOf(1);
    expect(parseInt(res.body.Operations[0].status, 10)).to.be.at.least(400);
  });
});
