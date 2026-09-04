import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import AuthzScope from '../../../src/plugins/auth/authzScope';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import AuthzPerRoute from '../../../src/plugins/auth/authzPerRoute';
import AuthzPerBranch from '../../../src/plugins/auth/authzPerBranch';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import type { DmRequest } from '../../../src/lib/auth/base';
import {
  skipIfMissingEnvVars,
  LDAP_ENV_VARS_WITH_ORG,
} from '../../helpers/env';

describe('Authorization scope endpoint', () => {
  let base: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS_WITH_ORG]);
  });

  before(() => {
    base = process.env.DM_LDAP_BASE as string;
  });

  /**
   * Build a server that believes it is talking to `user`, so the endpoint can
   * be exercised without a real authentication plugin.
   */
  const serve = async (
    user: string | undefined,
    withAuthz: boolean,
    opts: { perRoute?: boolean; perBranch?: string } = {}
  ): Promise<ReturnType<typeof supertest>> => {
    process.env.DM_LDAP_FLAT_SCHEMA = './static/schemas/twake/users.json';
    if (opts.perRoute) process.env.DM_AUTHZ_PER_ROUTES = `${user ?? ''}:*`;
    if (opts.perBranch) process.env.DM_AUTHZ_PER_BRANCH_CONFIG = opts.perBranch;
    const server = new DM();
    await server.ready;
    server.app.use((req, _res, next) => {
      if (user) (req as DmRequest).user = user;
      next();
    });
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    // Registered first on purpose: authzPerRoute sits in priority.json, so a
    // server combining route-level and branch-level authorization always has
    // it in hand before the branch-level one.
    if (opts.perRoute)
      await server.registerPlugin('authzPerRoute', new AuthzPerRoute(server));
    if (opts.perBranch)
      await server.registerPlugin('authzPerBranch', new AuthzPerBranch(server));
    if (withAuthz)
      await server.registerPlugin('authzLinid1', new AuthzLinid1(server));
    await server.registerPlugin('authzScope', new AuthzScope(server));
    server.setupErrorMiddleware();
    delete process.env.DM_AUTHZ_PER_ROUTES;
    delete process.env.DM_AUTHZ_PER_BRANCH_CONFIG;
    return supertest(server.app);
  };

  it('should say so when nothing restricts the caller', async () => {
    const request = await serve('alice.admin', false);
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('unrestricted', true);
    expect(res.body.entities.map((e: { name: string }) => e.name)).to.include(
      'users'
    );
    expect(res.body.entities.every((e: { create: boolean }) => e.create)).to.be
      .true;
  });

  it('should list the branches a local administrator manages', async () => {
    const request = await serve('alice.admin', true);
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('unrestricted', false);
    expect(res.body.user).to.equal(`uid=alice.admin,ou=users,${base}`);

    const branches = res.body.branches as {
      dn: string;
      name?: string;
      write?: boolean;
    }[];
    expect(branches.map(b => b.dn)).to.include(
      `ou=Test Org 1,ou=organization,${base}`
    );
    // The scope is shown in the directory's own words, not as a raw DN.
    expect(branches[0]).to.have.property('name', 'Test Org 1');
    expect(branches[0]).to.have.property('write', true);
  });

  it('should say which entities the caller may create', async () => {
    const request = await serve('alice.admin', true);
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    const entities = res.body.entities as { name: string; create: boolean }[];
    expect(entities.find(e => e.name === 'users')).to.have.property(
      'create',
      true
    );
  });

  it('should grant nothing to a user who administers no branch', async () => {
    const request = await serve('bob.user', true);
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    expect(res.status).to.equal(200);
    expect(res.body.branches).to.deep.equal([]);
    expect((res.body.entities as { create: boolean }[]).every(e => !e.create))
      .to.be.true;
  });

  it('should keep answering when a route-level plugin is loaded too', async () => {
    // `authzPerRoute` and `authzDynamic` carry the `authz` role without being
    // able to resolve a user or a branch. Picking the plugin by role alone
    // answered 500 to every caller on a server that combines the two.
    const request = await serve('alice.admin', true, { perRoute: true });
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property('unrestricted', false);
    expect((res.body.branches as { dn: string }[]).map(b => b.dn)).to.include(
      `ou=Test Org 1,ou=organization,${base}`
    );
  });

  it('should not offer create to an administrator who cannot write', async () => {
    // Creating an entry needs *write* on the branch it is attached to. A
    // read-only administrator was told `create: true`, rendered the form, and
    // got a 403 on submission — the round trip this endpoint exists to spare.
    const orgDn = `ou=Test Org 1,ou=organization,${base}`;
    const request = await serve('alice.admin', false, {
      perBranch: JSON.stringify({
        default: { read: false, write: false, delete: false },
        users: {
          'alice.admin': {
            [orgDn]: { read: true, write: false, delete: false },
          },
        },
      }),
    });
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body).to.have.property('unrestricted', false);
    expect((res.body.branches as { write?: boolean }[])[0]).to.have.property(
      'write',
      false
    );
    expect(
      (res.body.entities as { name: string; create: boolean }[]).every(
        e => !e.create
      ),
      JSON.stringify(res.body.entities)
    ).to.be.true;
  });

  it('should refuse an anonymous caller', async () => {
    const request = await serve(undefined, true);
    const res = await request
      .get('/api/v1/authz/scope')
      .set('Accept', 'application/json');
    expect(res.status).to.equal(401);
  });
});
