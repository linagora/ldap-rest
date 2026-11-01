import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';

describe('SCIM mapped reference DNs', function () {
  let server: DM;
  let dir: string;
  let userBase: string;
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scim-dn-'));
    const mapping = path.join(dir, 'user.json');
    fs.writeFileSync(
      mapping,
      JSON.stringify({
        resourceType: 'User',
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        // An attribute without DN syntax: the directory would store the
        // value as sent, so the mapping's own check is what refuses it
        entries: [
          {
            scim: 'manager',
            sub: { value: 'description' },
            subDn: ['value'],
          },
        ],
      })
    );
    setEnv('DM_SCIM_USER_BASE', userBase);
    setEnv('DM_SCIM_GROUP_BASE', `ou=groups,${baseDn}`);
    setEnv('DM_SCIM_USER_MAPPING', mapping);
    server = new DM();
    await new Scim(server).api(server.app);
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
    if (!server) return;
    await server.ldap.delete(`uid=scim-qx,${userBase}`).catch(() => undefined);
  });

  it('refuses a reference whose escape RFC 4514 does not define', async () => {
    const res = await supertest(server.app)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'scim-qx',
        manager: { value: 'uid=\\q\\x,ou=users,dc=example,dc=com' },
      })
      .expect(400);
    expect(res.body.scimType).to.equal('invalidValue');
    expect(res.body.detail).to.match(/RFC 4514/);
    let written = false;
    try {
      await server.ldap.search(
        { paged: false, scope: 'base' },
        `uid=scim-qx,${userBase}`
      );
      written = true;
    } catch {
      // the entry was never written
    }
    expect(written).to.equal(false);
  });

  it('writes a reference with a valid DN', async () => {
    const dn = 'uid=bob,ou=users,dc=example,dc=com';
    const res = await supertest(server.app)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'scim-qx',
        manager: { value: dn },
      })
      .expect(201);
    expect(res.body.manager).to.deep.equal({ value: dn });
  });
});
