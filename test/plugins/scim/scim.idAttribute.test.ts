import { expect } from 'chai';
import type { Request } from 'express';
import supertest from 'supertest';

import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';
import { AuthzRefusedError } from '../../../src/lib/errors';
import type { SearchOptions } from '../../../src/lib/ldapActions';

interface Member {
  value: string;
  type?: string;
  $ref?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('SCIM ids from --scim-id-attribute entryUUID', function () {
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
      DM_SCIM_ID_ATTRIBUTE: 'entryUUID',
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
      `cn=scim-uuid-group,ou=groups,${process.env.DM_LDAP_BASE}`,
      `cn=scim-uuid-child,ou=groups,${process.env.DM_LDAP_BASE}`,
      `uid=scim-uuid,${userBase}`,
    ]) {
      try {
        await plugin.ldap.delete(dn);
      } catch {
        /* ignore */
      }
    }
  });

  async function create(): Promise<string> {
    const res = await supertest(server.app)
      .post('/scim/v2/Users')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'scim-uuid',
        name: { familyName: 'Uuid', givenName: 'Ada' },
      })
      .expect(201);
    expect(res.body.id).to.match(UUID);
    expect(res.body.userName).to.equal('scim-uuid');
    return res.body.id as string;
  }

  it('answers the id on create and finds the user by it', async () => {
    const id = await create();
    const res = await supertest(server.app)
      .get(`/scim/v2/Users/${id}`)
      .expect(200);
    expect(res.body.id).to.equal(id);
    expect(res.body.userName).to.equal('scim-uuid');
  });

  it('does not take the RDN value for an id', async () => {
    await create();
    await supertest(server.app).get('/scim/v2/Users/scim-uuid').expect(404);
  });

  it('replaces, patches and deletes by id', async () => {
    const id = await create();
    await supertest(server.app)
      .put(`/scim/v2/Users/${id}`)
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'scim-uuid',
        name: { familyName: 'Uuid', givenName: 'Grace' },
      })
      .expect(200);
    const patched = await supertest(server.app)
      .patch(`/scim/v2/Users/${id}`)
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'title', value: 'Engineer' }],
      })
      .expect(200);
    expect(patched.body.name.givenName).to.equal('Grace');
    expect(patched.body.title).to.equal('Engineer');
    await supertest(server.app).delete(`/scim/v2/Users/${id}`).expect(204);
    await supertest(server.app).get(`/scim/v2/Users/${id}`).expect(404);
  });

  it('answers 404 for an unknown id', async () => {
    await supertest(server.app)
      .get('/scim/v2/Users/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('short-circuits id eq filters through the id attribute', async () => {
    const id = await create();
    const res = await supertest(server.app)
      .get('/scim/v2/Users')
      .query({ filter: `id eq "${id}"` })
      .expect(200);
    expect(res.body.totalResults).to.equal(1);
    expect(res.body.Resources[0].userName).to.equal('scim-uuid');
  });

  it("answers a group's members by their id, and their $ref resolves", async () => {
    const id = await create();
    const created = await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-uuid-group',
        members: [{ value: id }],
      })
      .expect(201);
    expect(created.body.id).to.match(UUID);
    const members = created.body.members as {
      value: string;
      type?: string;
      $ref?: string;
    }[];
    expect(members).to.have.length(1);
    expect(members[0].value).to.equal(id);
    expect(members[0].type).to.equal('User');
    expect(members[0].$ref).to.match(new RegExp(`/Users/${id}$`));

    const listed = await supertest(server.app)
      .get('/scim/v2/Groups')
      .query({ filter: 'displayName eq "scim-uuid-group"' })
      .expect(200);
    expect(listed.body.Resources[0].members[0].value).to.equal(id);

    const ref = new URL(members[0].$ref as string);
    const user = await supertest(server.app).get(ref.pathname).expect(200);
    expect(user.body.id).to.equal(id);
  });

  async function group(
    displayName: string,
    members: Member[]
  ): Promise<{ id: string; members?: Member[] }> {
    const res = await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName,
        members,
      })
      .expect(201);
    return res.body as { id: string; members?: Member[] };
  }

  /** Run `fn` with the reads of the user entry passed to `seen` */
  async function watchingUserReads<T>(
    seen: (base: string) => void,
    fn: () => Promise<T>
  ): Promise<T> {
    const userDn = `uid=scim-uuid,${userBase}`.toLowerCase();
    type Args = [string, SearchOptions, Request?];
    const hook = ([base, opts, req]: Args): Args => {
      if (String(base).toLowerCase() === userDn) seen(base);
      return [base, opts, req];
    };
    server.hookBus.subscribe('ldapsearchrequest', hook);
    try {
      return await fn();
    } finally {
      server.hookBus.unsubscribe('ldapsearchrequest', hook);
    }
  }

  it('resolves a nested group by its id, and a PUT of what was read keeps it', async () => {
    const child = await group('scim-uuid-child', []);
    expect(child.id).to.match(UUID);
    for (const member of [
      { value: child.id, type: 'Group' },
      { value: child.id },
    ]) {
      const parent = await group('scim-uuid-group', [member]);
      expect(parent.members).to.deep.include({
        value: child.id,
        type: 'Group',
        $ref: parent.members?.[0].$ref,
      });
      expect(parent.members?.[0].$ref).to.match(
        new RegExp(`/Groups/${child.id}$`)
      );
      const replaced = await supertest(server.app)
        .put(`/scim/v2/Groups/${parent.id}`)
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'scim-uuid-group',
          members: parent.members,
        })
        .expect(200);
      expect(replaced.body.members).to.have.length(1);
      expect(replaced.body.members[0].value).to.equal(child.id);
      await supertest(server.app)
        .delete(`/scim/v2/Groups/${parent.id}`)
        .expect(204);
    }
  });

  it('answers a member the caller may not read by its RDN value', async () => {
    const id = await create();
    const created = await group('scim-uuid-group', [{ value: id }]);
    const refuse = (): never => {
      throw new AuthzRefusedError('not in your branch');
    };
    await watchingUserReads(refuse, async () => {
      const res = await supertest(server.app)
        .get(`/scim/v2/Groups/${created.id}`)
        .expect(200);
      expect(res.body.members).to.have.length(1);
      expect(res.body.members[0].value).to.equal('scim-uuid');
      await supertest(server.app)
        .get('/scim/v2/Groups')
        .query({
          filter: 'displayName eq "scim-uuid-group"',
          attributes: 'displayName',
        })
        .expect(200);
    });
  });

  it('reads no member when the answer leaves members out', async () => {
    const id = await create();
    const created = await group('scim-uuid-group', [{ value: id }]);
    let reads = 0;
    const count = (): void => {
      reads++;
    };
    await watchingUserReads(count, async () => {
      const one = await supertest(server.app)
        .get(`/scim/v2/Groups/${created.id}`)
        .query({ attributes: 'displayName' })
        .expect(200);
      expect(one.body.members).to.be.undefined;
      await supertest(server.app)
        .get('/scim/v2/Groups')
        .query({ excludedAttributes: 'members' })
        .expect(200);
    });
    expect(reads).to.equal(0);
    await watchingUserReads(count, () =>
      supertest(server.app).get(`/scim/v2/Groups/${created.id}`).expect(200)
    );
    expect(reads).to.be.greaterThan(0);
  });
});
