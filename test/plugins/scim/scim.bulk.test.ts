import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

describe('SCIM Bulk (integration)', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  let groupBase: string;

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
    process.env.DM_SCIM_USER_BASE = userBase;
    process.env.DM_SCIM_GROUP_BASE = groupBase;
    server = new DM();
    plugin = new Scim(server);
    await plugin.api(server.app);
    await server.ready;
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
    const found = (
      group.body.members as { value: string }[] | undefined
    )?.some(m => m.value === 'bulk-u1');
    expect(found, 'group should contain bulk-u1').to.be.true;
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
