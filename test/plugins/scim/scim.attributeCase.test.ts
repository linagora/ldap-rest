import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';

describe('SCIM mapping attribute names in another case', function () {
  let server: DM;
  let plugin: Scim;
  let userBase: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  const setEnv = (name: string, value: string): void => {
    saved[name] = process.env[name];
    process.env[name] = value;
  };

  before(async function () {
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      console.warn('Skipping SCIM integration tests: LDAP env vars missing');
      this.skip();
      return;
    }
    const baseDn = process.env.DM_LDAP_BASE;
    userBase = `ou=users,${baseDn}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scim-case-'));
    const mapping = path.join(dir, 'user.json');
    fs.writeFileSync(
      mapping,
      JSON.stringify({
        resourceType: 'User',
        schemas: [USER],
        // The directory answers these under their schema spelling
        entries: [
          { scim: 'userName', ldap: 'uid' },
          { scim: 'displayName', ldap: 'displayname' },
          {
            scim: 'emails',
            ldapPrimary: 'mail',
            ldapSecondary: 'mailalternateaddress',
            multi: 'array',
          },
        ],
      })
    );
    setEnv('DM_SCIM_USER_BASE', userBase);
    setEnv('DM_SCIM_GROUP_BASE', `ou=groups,${baseDn}`);
    setEnv('DM_SCIM_USER_MAPPING', mapping);
    // The test directory's inetOrgPerson does not allow mailAlternateAddress;
    // the Twake classes do, and carry the name attributes too
    setEnv('DM_SCIM_USER_OBJECT_CLASSES', 'top;twakeAccount;twakeWhitePages');
    setEnv('DM_SCIM_USER_LOCK_ATTRIBUTE', 'employeeType');
    setEnv('DM_SCIM_USER_LOCK_VALUE', 'disabled');
    server = new DM();
    plugin = new Scim(server);
    plugin.api(server.app);
    await server.ready;
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (!plugin) return;
    await plugin.ldap
      .delete(`uid=scim-case,${userBase}`)
      .catch(() => undefined);
  });

  const create = async (): Promise<void> => {
    const res = await supertest(server.app)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: [USER],
        userName: 'scim-case',
        name: { familyName: 'Case', givenName: 'Alice' },
        displayName: 'Alice Case',
        emails: [
          { value: 'alice@case.test', primary: true },
          { value: 'alice@alt.test' },
        ],
      });
    expect(res.status).to.equal(201);
  };

  it('reads the attributes the directory answers under another spelling', async () => {
    await create();
    const res = await supertest(server.app)
      .get('/scim/v2/Users/scim-case')
      .set('Accept', 'application/scim+json')
      .expect(200);
    expect(res.body.displayName).to.equal('Alice Case');
    expect(res.body.emails).to.deep.equal([
      { value: 'alice@case.test', primary: true },
      { value: 'alice@alt.test' },
    ]);
  });

  it('removes an attribute the directory holds under another spelling', async () => {
    await create();
    await supertest(server.app)
      .patch('/scim/v2/Users/scim-case')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: 'displayName' }],
      })
      .expect(200);
    const res = await supertest(server.app)
      .get('/scim/v2/Users/scim-case')
      .set('Accept', 'application/scim+json')
      .expect(200);
    expect(res.body).to.not.have.property('displayName');
  });

  it('clears an attribute the body omits on PUT, whatever its spelling', async () => {
    await create();
    await supertest(server.app)
      .put('/scim/v2/Users/scim-case')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: [USER],
        userName: 'scim-case',
        name: { familyName: 'Case', givenName: 'Alice' },
        emails: [{ value: 'alice@case.test', primary: true }],
      })
      .expect(200);
    const res = await supertest(server.app)
      .get('/scim/v2/Users/scim-case')
      .set('Accept', 'application/scim+json')
      .expect(200);
    expect(res.body).to.not.have.property('displayName');
  });
});
