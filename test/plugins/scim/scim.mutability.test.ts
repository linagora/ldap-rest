import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect } from 'chai';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';
import { ScimError } from '../../../src/plugins/scim/errors';
import { scimFilterToLdap } from '../../../src/plugins/scim/filter';
import {
  DEFAULT_GROUP_MAPPING,
  DEFAULT_USER_MAPPING,
  ldapToScimGroup,
  ldapToScimUser,
  requiredLdapAttributes,
  type MappingContext,
} from '../../../src/plugins/scim/mapping';
import { patchToModifyRequest } from '../../../src/plugins/scim/patch';
import type { ResourceMapping } from '../../../src/plugins/scim/types';

const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';

const mapping: ResourceMapping = {
  ...DEFAULT_USER_MAPPING,
  entries: [
    ...DEFAULT_USER_MAPPING.entries,
    { scim: 'secret', ldap: 'description', writeOnly: true },
    { scim: 'desc', ldap: 'description' },
    { scim: 'password', ldap: 'userPassword' },
    { scim: 'ntHash', ldap: 'sambaNTPassword' },
    { scim: 'credentials', sub: { login: 'uid', hash: 'userPassword' } },
    { scim: 'entryDN', ldap: 'entryDN', operational: true, readOnly: true },
  ],
};

const ctx: MappingContext = {
  idAttribute: 'rdn',
  rdnAttribute: 'uid',
  resourceType: 'User',
  scimPrefix: '/scim/v2',
  lockAttribute: 'employeeType',
  lockValue: 'disabled',
};

function scimTypeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).to.be.instanceOf(ScimError);
    return (err as ScimError).scimType;
  }
  return undefined;
}

describe('SCIM mapping mutability', () => {
  describe('write-only entries', () => {
    it('are never returned, and userPassword is write-only by default', () => {
      const user = ldapToScimUser(
        {
          uid: 'alice',
          description: 'top secret',
          userPassword: '{SSHA}hash',
          sambaNTPassword: 'NTHASH',
          entryDN: 'uid=alice,dc=example,dc=com',
        },
        mapping,
        ctx
      ) as Record<string, unknown>;
      expect(user).to.not.have.property('secret');
      // Another entry on the same attribute would hand it back
      expect(user).to.not.have.property('desc');
      expect(user).to.not.have.property('password');
      expect(user).to.not.have.property('ntHash');
      expect(user.credentials).to.deep.equal({ login: 'alice' });
      expect(user.entryDN).to.equal('uid=alice,dc=example,dc=com');
    });

    it('are left out of a group too', () => {
      const group = ldapToScimGroup(
        { cn: 'admins', userPassword: '{SSHA}hash' },
        {
          ...DEFAULT_GROUP_MAPPING,
          entries: [
            ...DEFAULT_GROUP_MAPPING.entries,
            { scim: 'password', ldap: 'userPassword' },
          ],
        },
        { ...ctx, resourceType: 'Group', rdnAttribute: 'cn' }
      ) as Record<string, unknown>;
      expect(group.displayName).to.equal('admins');
      expect(group).to.not.have.property('password');
    });

    it('are fetched only when asked, for a PATCH', () => {
      const read = requiredLdapAttributes(mapping).map(a => a.toLowerCase());
      expect(read).to.not.include.members(['description']);
      expect(read).to.not.include('userpassword');
      expect(read).to.not.include('sambantpassword');
      expect(read).to.include('uid');
      const patch = requiredLdapAttributes(mapping, [], true);
      expect(patch).to.include.members(['description', 'userPassword']);
    });

    it('cannot be filtered on', () => {
      for (const filter of [
        'secret eq "x"',
        'desc eq "x"',
        'password sw "{SSHA"',
        'password pr',
        'ntHash eq "x"',
        'credentials.hash pr',
      ])
        expect(scimTypeOf(() => scimFilterToLdap(filter, mapping))).to.equal(
          'invalidFilter'
        );
    });

    it('PATCH add replaces the value rather than adding a second one', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: [PATCH_OP],
          Operations: [{ op: 'add', path: 'password', value: 'new' }],
        },
        { mapping, current: { userPassword: '{SSHA}old' } }
      );
      expect(req).to.deep.equal({ replace: { userPassword: 'new' } });
    });

    it('PATCH remove deletes the value', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: [PATCH_OP],
          Operations: [{ op: 'remove', path: 'password' }],
        },
        { mapping, current: { userPassword: '{SSHA}old' } }
      );
      expect(req).to.deep.equal({ delete: { userPassword: '' } });
    });
  });

  describe('read-only entries', () => {
    it('PATCH with a path naming one is refused with mutability', async () => {
      let error: unknown;
      try {
        await patchToModifyRequest(
          {
            schemas: [PATCH_OP],
            Operations: [{ op: 'replace', path: 'entryDN', value: 'x' }],
          },
          { mapping, current: {} }
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(ScimError);
      expect((error as ScimError).scimType).to.equal('mutability');
    });

    it('PATCH without a path skips them', async () => {
      const req = await patchToModifyRequest(
        {
          schemas: [PATCH_OP],
          Operations: [
            {
              op: 'replace',
              value: { entryDN: 'x', displayName: 'Alice' },
            },
          ],
        },
        { mapping, current: {} }
      );
      expect(req).to.deep.equal({ replace: { displayName: 'Alice' } });
    });
  });

  describe('over HTTP', function () {
    let server: DM;
    let plugin: Scim;
    let userBase: string;
    let dir: string;
    const saved: Record<string, string | undefined> = {};
    const env = (name: string, value: string): void => {
      if (!(name in saved)) saved[name] = process.env[name];
      process.env[name] = value;
    };

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
      dir = mkdtempSync(join(tmpdir(), 'scim-mutability-'));
      const file = join(dir, 'mapping.json');
      writeFileSync(
        file,
        JSON.stringify({
          resourceType: 'User',
          schemas: [USER],
          entries: [
            { scim: 'password', ldap: 'userPassword' },
            {
              scim: 'entryDN',
              ldap: 'entryDN',
              operational: true,
              readOnly: true,
            },
          ],
        })
      );
      env('DM_SCIM_USER_BASE', userBase);
      env('DM_SCIM_GROUP_BASE', `ou=groups,${baseDn}`);
      env('DM_SCIM_USER_LOCK_ATTRIBUTE', 'employeeType');
      env('DM_SCIM_USER_LOCK_VALUE', 'disabled');
      env('DM_SCIM_USER_MAPPING', file);
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
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    afterEach(async () => {
      if (!plugin) return;
      try {
        await plugin.ldap.delete(`uid=scim-mut,${userBase}`);
      } catch {
        /* ignore */
      }
    });

    const storedPassword = async (): Promise<unknown> => {
      const res = (await plugin.ldap.search(
        { paged: false, scope: 'base', attributes: ['userPassword'] },
        `uid=scim-mut,${userBase}`
      )) as { searchEntries: Record<string, unknown>[] };
      return res.searchEntries[0].userPassword;
    };

    it('writes the password, never returns it, and a PUT keeps it and skips entryDN', async () => {
      const created = await supertest(server.app)
        .post('/scim/v2/Users')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: [USER],
          userName: 'scim-mut',
          name: { familyName: 'Mut' },
          password: 'secret-1',
        })
        .expect(201);
      expect(created.body).to.not.have.property('password');
      expect(created.body.entryDN).to.match(/^uid=scim-mut,/i);
      expect(await storedPassword()).to.equal('secret-1');

      const read = await supertest(server.app)
        .get('/scim/v2/Users/scim-mut')
        .expect(200);
      expect(read.body).to.not.have.property('password');
      const list = await supertest(server.app)
        .get('/scim/v2/Users')
        .query({ filter: 'userName eq "scim-mut"' })
        .expect(200);
      expect(list.body.Resources[0]).to.not.have.property('password');

      // The body read back: entryDN present, password absent
      const put = await supertest(server.app)
        .put('/scim/v2/Users/scim-mut')
        .set('Content-Type', 'application/scim+json')
        .send({ ...read.body, displayName: 'Replaced' })
        .expect(200);
      expect(put.body.displayName).to.equal('Replaced');
      expect(put.body).to.not.have.property('password');
      expect(await storedPassword()).to.equal('secret-1');

      // entryDN absent from the body: still not deleted
      const { entryDN: _dn, ...withoutDn } = read.body as Record<
        string,
        unknown
      >;
      await supertest(server.app)
        .put('/scim/v2/Users/scim-mut')
        .set('Content-Type', 'application/scim+json')
        .send({ ...withoutDn, password: 'secret-2' })
        .expect(200);
      expect(await storedPassword()).to.equal('secret-2');

      await supertest(server.app)
        .patch('/scim/v2/Users/scim-mut')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: [PATCH_OP],
          Operations: [{ op: 'remove', path: 'password' }],
        })
        .expect(200);
      expect([await storedPassword()].flat().filter(Boolean)).to.deep.equal([]);
    });

    it('refuses a filter on the password', async () => {
      const res = await supertest(server.app)
        .get('/scim/v2/Users')
        .query({ filter: 'password sw "s"' })
        .expect(400);
      expect(res.body.scimType).to.equal('invalidFilter');
    });
  });
});
