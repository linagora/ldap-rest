/**
 * Regression test for issue #80: SCIM writes must honour `core/auth/authzPerBranch`.
 *
 * `authzPerBranch` enforces per-branch permissions through the
 * `ldap{add,modify,delete}request` hooks, which authorize against `req.user`.
 * SCIM writes used to call `ldap.add/modify/delete` WITHOUT threading the
 * request, so the hooks ran with no `req`, `shouldSkipAuthorization` returned
 * true, and the write was allowed unconditionally — an identity restricted to
 * one branch could create/delete entries anywhere via SCIM.
 *
 * These tests stack a header-based auth plugin (populates `req.user`) UNDER
 * `core/auth/authzPerBranch` UNDER `core/scim`, and assert that a SCIM write
 * to a branch the identity is not permitted to modify is rejected (403),
 * exactly like a directly issued LDAP write.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import Scim from '../../../src/plugins/scim/scim';
import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import type { Hooks } from '../../../src/hooks';

/** Minimal auth plugin: identifies the caller from the `x-scim-user` header. */
class HeaderAuthPlugin extends AuthBase {
  name = 'headerAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-scim-user'];
    if (user && typeof user === 'string') {
      req.user = user;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function wireHooks(server: DM, plugin: { hooks?: Hooks }): void {
  if (!plugin.hooks) return;
  for (const [name, fn] of Object.entries(plugin.hooks)) {
    if (!fn) continue;
    const list = (server.hooks[name] =
      server.hooks[name] || ([] as unknown[] as never));
    (list as unknown as Array<unknown>).push(fn as unknown);
  }
}

describe('SCIM + authzPerBranch — per-branch write enforcement (#80)', function () {
  let server: DM;
  let baseDn: string;
  let peopleBase: string;

  const envKeys = [
    'DM_AUTHZ_PER_BRANCH_CONFIG',
    'DM_AUTHZ_PER_BRANCH_CACHE_TTL',
    'DM_SCIM_USER_BASE',
    'DM_SCIM_USER_BASE_TEMPLATE',
    'DM_SCIM_GROUP_BASE',
    'DM_GROUP_SCHEMA',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  before(async function () {
    this.timeout(30000);
    if (
      !process.env.DM_LDAP_DN ||
      !process.env.DM_LDAP_PWD ||
      !process.env.DM_LDAP_BASE
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        'Skipping SCIM+authzPerBranch integration tests: LDAP env vars missing'
      );
      this.skip();
      return;
    }
    baseDn = process.env.DM_LDAP_BASE;
    peopleBase = `ou=people80,${baseDn}`;

    for (const k of envKeys) savedEnv[k] = process.env[k];

    // writer: full rights on peopleBase. reader: read-only (no write/delete).
    process.env.DM_AUTHZ_PER_BRANCH_CONFIG = JSON.stringify({
      default: { read: false, write: false, delete: false },
      users: {
        writer: { [peopleBase]: { read: true, write: true, delete: true } },
        reader: { [peopleBase]: { read: true, write: false, delete: false } },
      },
      groups: {},
    });
    process.env.DM_AUTHZ_PER_BRANCH_CACHE_TTL = '60';
    process.env.DM_SCIM_USER_BASE = peopleBase;
    delete process.env.DM_SCIM_USER_BASE_TEMPLATE;
    delete process.env.DM_SCIM_GROUP_BASE;
    process.env.DM_GROUP_SCHEMA = '';

    server = new DM();

    // Auth middleware first so SCIM routes registered afterwards run after it.
    const auth = new HeaderAuthPlugin(server);
    auth.api(server.app);

    const authz = new AuthzPerBranch(server);
    wireHooks(server, authz);

    const scim = new Scim(server);
    await scim.api(server.app);
    wireHooks(server, scim);

    server.loadedPlugins['headerAuth'] = auth;
    server.loadedPlugins['authzPerBranch'] = authz;
    server.loadedPlugins['scim'] = scim;
    await server.ready;

    try {
      await server.ldap.add(peopleBase, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'people80',
      });
    } catch {
      /* may already exist */
    }
  });

  after(async () => {
    if (server) {
      for (const dn of [
        `uid=alice,${peopleBase}`,
        `uid=bob,${peopleBase}`,
        peopleBase,
      ]) {
        try {
          await server.ldap.delete(dn);
        } catch {
          /* ignore */
        }
      }
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  afterEach(async () => {
    for (const dn of [`uid=alice,${peopleBase}`, `uid=bob,${peopleBase}`]) {
      try {
        await server.ldap.delete(dn);
      } catch {
        /* ignore */
      }
    }
  });

  const createUser = (user: string, userName: string) =>
    supertest(server.app)
      .post('/scim/v2/Users')
      .set('x-scim-user', user)
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName,
        name: { familyName: 'Doe' },
      });

  it('rejects unauthenticated SCIM access (401)', async () => {
    await supertest(server.app).get('/scim/v2/Users').expect(401);
  });

  it('writer (write granted) CAN create a user via SCIM', async () => {
    await createUser('writer', 'alice').expect(201);
    const res = await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['uid'] },
      `uid=alice,${peopleBase}`
    );
    expect(
      (res as { searchEntries: unknown[] }).searchEntries
    ).to.have.lengthOf(1);
  });

  it('reader (write denied) is DENIED create with 403 — regression for #80', async () => {
    const res = await createUser('reader', 'bob').expect(403);
    // Marker must never leak to the client.
    expect(JSON.stringify(res.body)).to.not.match(/\[authz-forbidden\]/);

    // And nothing must have been written: a base-scoped search on the absent
    // entry raises noSuchObject (0x20), which equally proves bob was not created.
    let entries: unknown[] = [];
    try {
      const search = await server.ldap.search(
        { paged: false, scope: 'base', attributes: ['uid'] },
        `uid=bob,${peopleBase}`
      );
      entries = (search as { searchEntries: unknown[] }).searchEntries;
    } catch (err) {
      expect((err as { code?: number }).code).to.equal(32); // noSuchObject
    }
    expect(entries).to.have.lengthOf(0);
  });

  it('reader (write denied) is DENIED update (PUT) with 403', async () => {
    await createUser('writer', 'alice').expect(201);

    // reader has read (GET resolves) but not write → modify hook denies (403).
    const res = await supertest(server.app)
      .put('/scim/v2/Users/alice')
      .set('x-scim-user', 'reader')
      .set('Content-Type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'alice',
        name: { familyName: 'Hax' },
      })
      .expect(403);
    expect(JSON.stringify(res.body)).to.not.match(/\[authz-forbidden\]/);
  });

  it('reader (delete denied) CANNOT delete a user, writer CAN', async () => {
    await createUser('writer', 'alice').expect(201);

    // reader has read (so GET resolves) but not delete → 403, entry survives.
    await supertest(server.app)
      .delete('/scim/v2/Users/alice')
      .set('x-scim-user', 'reader')
      .expect(403);
    const stillThere = await server.ldap.search(
      { paged: false, scope: 'base', attributes: ['uid'] },
      `uid=alice,${peopleBase}`
    );
    expect(
      (stillThere as { searchEntries: unknown[] }).searchEntries
    ).to.have.lengthOf(1);

    // writer has delete → succeeds.
    await supertest(server.app)
      .delete('/scim/v2/Users/alice')
      .set('x-scim-user', 'writer')
      .expect(204);
  });
});
