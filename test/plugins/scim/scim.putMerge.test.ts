import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';

describe('SCIM PUT with --scim-put-semantics merge', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  let groupBase: string;
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
    groupBase = `ou=groups,${baseDn}`;
    Object.assign(env, {
      DM_SCIM_USER_BASE: userBase,
      DM_SCIM_GROUP_BASE: groupBase,
      DM_SCIM_PUT_SEMANTICS: 'merge',
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
  });

  after(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  afterEach(async () => {
    if (!plugin) return;
    for (const dn of [
      `cn=scim-merge-group,${groupBase}`,
      `uid=scim-merge,${userBase}`,
    ]) {
      try {
        await plugin.ldap.delete(dn);
      } catch {
        /* ignore */
      }
    }
  });

  const createUser = (): supertest.Test =>
    supertest(server.app)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: [USER],
        userName: 'scim-merge',
        name: { familyName: 'Merge', givenName: 'Max' },
        title: 'Engineer',
        emails: [{ value: 'max@example.com', primary: true }],
      })
      .expect(201);

  it('keeps the attributes a PUT leaves out', async () => {
    await createUser();
    const res = await supertest(server.app)
      .put('/scim/v2/Users/scim-merge')
      .set('Content-Type', 'application/scim+json')
      .send({ schemas: [USER], userName: 'scim-merge', title: 'Manager' })
      .expect(200);
    expect(res.body.title).to.equal('Manager');
    expect(res.body.name.familyName).to.equal('Merge');
    expect(res.body.name.givenName).to.equal('Max');
    expect(res.body.emails[0].value).to.equal('max@example.com');
  });

  it('replaces the sub-attributes it is sent, keeping the others', async () => {
    await createUser();
    const res = await supertest(server.app)
      .put('/scim/v2/Users/scim-merge')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: [USER],
        userName: 'scim-merge',
        name: { givenName: 'Maxine' },
      })
      .expect(200);
    expect(res.body.name.givenName).to.equal('Maxine');
    expect(res.body.name.familyName).to.equal('Merge');
  });

  it('keeps the members of a group a PUT leaves out', async () => {
    await createUser();
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: [GROUP],
        displayName: 'scim-merge-group',
        members: [{ value: 'scim-merge' }],
      })
      .expect(201);
    const res = await supertest(server.app)
      .put('/scim/v2/Groups/scim-merge-group')
      .set('Content-Type', 'application/scim+json')
      .send({ schemas: [GROUP], displayName: 'scim-merge-group' })
      .expect(200);
    expect(res.body.members.map((m: { value: string }) => m.value)).to.include(
      'scim-merge'
    );
  });
});
