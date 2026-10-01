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
  let savedExternalId: string | undefined;

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
    // groupOfNames has no attribute meant for a provisioning client's id, so
    // the deployment names one. `description` is the portable choice.
    savedExternalId = process.env.DM_SCIM_GROUP_EXTERNAL_ID_ATTRIBUTE;
    process.env.DM_SCIM_GROUP_EXTERNAL_ID_ATTRIBUTE = 'description';
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
    if (savedExternalId === undefined)
      delete process.env.DM_SCIM_GROUP_EXTERNAL_ID_ATTRIBUTE;
    else process.env.DM_SCIM_GROUP_EXTERNAL_ID_ATTRIBUTE = savedExternalId;
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
    // RFC 7644 section 3.1: a create answers with the Location header,
    // prefix-relative unless --scim-base-url pins an absolute one.
    expect(res.headers.location).to.equal('/scim/v2/Groups/scim-testgroup');
    expect(res.headers.location).to.not.match(/^https?:/);
  });

  it('keeps displayName as the RDN when the mapping stores it there', async () => {
    let seenBase: string | undefined;
    const hook = ([group, req, base]: [
      Record<string, unknown>,
      unknown,
      string,
    ]) => {
      seenBase = base;
      return [{ ...group, id: 'from-hook' }, req, base];
    };
    (server.hooks.scimgroupcreate ||= []).push(hook);
    try {
      const res = await supertest(server.app)
        .post('/scim/v2/Groups')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'scim-testgroup',
        })
        .expect(201);
      expect(res.body.id).to.equal('scim-testgroup');
      expect(res.body.displayName).to.equal('scim-testgroup');
      expect(seenBase).to.equal(groupBase);
    } finally {
      const hooks = server.hooks.scimgroupcreate as unknown[];
      hooks.splice(hooks.indexOf(hook), 1);
    }
  });

  it('stores and returns the client externalId', async () => {
    const created = await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
        externalId: '00g1emaKYZTWRINFRGETl',
        members: [{ value: 'scim-groupuser' }],
      })
      .expect(201);
    // The value the client sent, not a server-assigned entryUUID.
    expect(created.body.externalId).to.equal('00g1emaKYZTWRINFRGETl');

    const got = await supertest(server.app)
      .get('/scim/v2/Groups/scim-testgroup')
      .expect(200);
    expect(got.body.externalId).to.equal('00g1emaKYZTWRINFRGETl');

    // And the identity provider can find its group back by that id.
    const found = await supertest(server.app)
      .get(
        '/scim/v2/Groups?filter=' +
          encodeURIComponent('externalId eq "00g1emaKYZTWRINFRGETl"')
      )
      .expect(200);
    expect(found.body.totalResults).to.equal(1);
    expect(found.body.Resources[0].id).to.equal('scim-testgroup');
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

  it('hides the schema placeholder however its DN is spelled', async () => {
    // The configuration holds one spelling, the directory answers with its
    // own: compared as text, the placeholder was served to the client as an
    // ordinary member.
    const saved = server.config.group_dummy_user;
    server.config.group_dummy_user = 'CN = FakeUser';
    try {
      await supertest(server.app)
        .post('/scim/v2/Groups')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'scim-testgroup',
        })
        .expect(201);
      const res = await supertest(server.app)
        .get('/scim/v2/Groups/scim-testgroup')
        .expect(200);
      expect(res.body.members || []).to.deep.equal([]);
    } finally {
      server.config.group_dummy_user = saved;
    }
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

  describe('concurrent PATCHes', () => {
    const others = ['scim-m1', 'scim-m2'];
    const dnOf = (uid: string) => `uid=${uid},${userBase}`.toLowerCase();
    const members = async (): Promise<string[]> => {
      const found = (await plugin.ldap.search(
        { scope: 'base', paged: false, attributes: ['member'] },
        `cn=scim-testgroup,${groupBase}`
      )) as { searchEntries: { member?: string | string[] }[] };
      return ([] as string[])
        .concat(found.searchEntries[0]?.member ?? [])
        .map(m => m.toLowerCase());
    };
    const remove = (uid: string) =>
      supertest(server.app)
        .patch('/scim/v2/Groups/scim-testgroup')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'remove', path: `members[value eq "${uid}"]` }],
        });

    beforeEach(async () => {
      for (const uid of others)
        await plugin.ldap
          .add(`uid=${uid},${userBase}`, {
            objectClass: ['top', 'inetOrgPerson'],
            cn: uid,
            sn: uid,
            uid,
          })
          .catch(() => undefined);
      await supertest(server.app)
        .post('/scim/v2/Groups')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'scim-testgroup',
          members: [
            { value: 'scim-groupuser' },
            ...others.map(value => ({ value })),
          ],
        })
        .expect(201);
    });

    afterEach(async () => {
      for (const uid of others)
        await plugin.ldap
          .delete(`uid=${uid},${userBase}`)
          .catch(() => undefined);
    });

    it('both apply when each removes a different member', async () => {
      // Each used to replace the list from its own read, and the second
      // put back the member the first had removed
      const [one, two] = await Promise.all([
        remove('scim-m1'),
        remove('scim-m2'),
      ]);
      expect([one.status, two.status]).to.deep.equal([200, 200]);
      expect(await members()).to.deep.equal([dnOf('scim-groupuser')]);
    });

    it('plays again on a fresh read when another removed the same member', async () => {
      // Another writer removes scim-m1 between this PATCH's read and write
      let raced = false;
      const race = async (args: unknown[]) => {
        if (!raced) {
          raced = true;
          await plugin.ldap.modify(`cn=scim-testgroup,${groupBase}`, {
            delete: { member: `uid=scim-m1,${userBase}` },
          });
        }
        return args;
      };
      server.hooks.ldapmodifyrequest = [
        ...(server.hooks.ldapmodifyrequest || []),
        race as never,
      ];
      try {
        await remove('scim-m1').expect(200);
      } finally {
        server.hooks.ldapmodifyrequest = server.hooks.ldapmodifyrequest!.filter(
          h => h !== (race as never)
        );
      }
      expect(await members()).to.have.members([
        dnOf('scim-groupuser'),
        dnOf('scim-m2'),
      ]);
    });
  });

  it('PATCH removes a member without dropping one a search filter hides', async () => {
    const hiddenDn = `uid=scim-hidden,${userBase}`;
    await plugin.ldap
      .add(hiddenDn, {
        objectClass: ['top', 'inetOrgPerson', 'organizationalPerson', 'person'],
        cn: 'Hidden',
        sn: 'Hidden',
        uid: 'scim-hidden',
      })
      .catch(() => undefined);
    await supertest(server.app)
      .post('/scim/v2/Groups')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'scim-testgroup',
        members: [{ value: 'scim-groupuser' }, { value: 'scim-hidden' }],
      })
      .expect(201);
    // What a plugin hiding some members from API reads does
    const hide = ([result, req, opts]: [
      { searchEntries: Record<string, unknown>[] },
      unknown,
      unknown,
    ]) => {
      if (req)
        for (const e of result.searchEntries)
          if (Array.isArray(e.member))
            e.member = (e.member as string[]).filter(
              m => m.toLowerCase() !== hiddenDn.toLowerCase()
            );
      return [result, req, opts];
    };
    server.hooks.ldapsearchfilter = [
      ...(server.hooks.ldapsearchfilter || []),
      hide as never,
    ];
    const patch = (Operations: unknown[]) =>
      supertest(server.app)
        .patch('/scim/v2/Groups/scim-testgroup')
        .set('Content-Type', 'application/scim+json')
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations,
        })
        .expect(200);
    try {
      await patch([
        { op: 'remove', path: 'members[value eq "scim-groupuser"]' },
      ]);
      // Adding back the member it cannot see: already there, no error
      await patch([
        { op: 'add', path: 'members', value: [{ value: 'scim-hidden' }] },
      ]);
    } finally {
      server.hooks.ldapsearchfilter = server.hooks.ldapsearchfilter!.filter(
        h => h !== (hide as never)
      );
      const found = (await plugin.ldap.search(
        { scope: 'base', paged: false, attributes: ['member'] },
        `cn=scim-testgroup,${groupBase}`
      )) as { searchEntries: { member?: string | string[] }[] };
      const members = ([] as string[])
        .concat(found.searchEntries[0]?.member ?? [])
        .map(m => m.toLowerCase());
      await plugin.ldap.delete(hiddenDn).catch(() => undefined);
      expect(members).to.include(hiddenDn.toLowerCase());
      expect(members).not.to.include(
        `uid=scim-groupuser,${userBase}`.toLowerCase()
      );
    }
  });

  it('keeps the members when a removal names someone the directory lost', async () => {
    // The routine way an identity provider meets this: it withdraws a member
    // that has since been deleted from the directory, so the reference does
    // not resolve. That used to be read as the bare `remove members`, which
    // takes every member — the group came back holding nothing but the
    // schema placeholder, and the answer was 200.
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
          { op: 'remove', path: 'members', value: [{ value: 'no-such-user' }] },
        ],
      })
      .expect(200);
    const res = await supertest(server.app)
      .get('/scim/v2/Groups/scim-testgroup')
      .expect(200);
    const members = (res.body.members as { value: string }[] | undefined) || [];
    expect(
      members.some(m => m.value === 'scim-groupuser'),
      `members after the no-op removal: ${JSON.stringify(members)}`
    ).to.be.true;
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

  it('rejects a filter on active, which Groups do not carry', async () => {
    const res = await supertest(server.app)
      .get('/scim/v2/Groups?filter=' + encodeURIComponent('active pr'))
      .expect(400);
    expect(res.body.scimType).to.equal('invalidFilter');
    const eq = await supertest(server.app)
      .get('/scim/v2/Groups?filter=' + encodeURIComponent('active eq true'))
      .expect(400);
    expect(eq.body.scimType).to.equal('invalidFilter');
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
