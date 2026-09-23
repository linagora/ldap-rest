/**
 * An authenticated identity that does not resolve (GHSA-3q8f-fg3r-wgp2).
 *
 * `shouldSkipAuthorization` skips the request that carries no identity,
 * which is the anonymous case and deliberate. The hooks used to *also* pass
 * the operation through when `resolveUser` answered null — a `warn`, then
 * the read, the write or the delete went ahead.
 *
 * `authzLinid1` resolves `req.user` by searching
 * `(<ldap_user_main_attribute>=<identity>)`, so any authenticator publishing
 * something that is not a uid — `core/auth/openidconnect` publishes the OIDC
 * `sub` — resolved to nothing on every request, and the whole tree was open
 * to anyone the identity provider admitted. Reproduced here without a
 * provider: an identity that is simply not in the directory.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../../src/bin';
import AuthBase, { type DmRequest } from '../../../src/lib/auth/base';
import type { Role } from '../../../src/abstract/plugin';
import AuthzLinid1 from '../../../src/plugins/auth/authzLinid1';
import LdapFlatGeneric from '../../../src/plugins/ldap/flatGeneric';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

/** Authentication reduced to a header: this is about what follows it */
class TestAuthPlugin extends AuthBase {
  name = 'testAuth';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string' && user) {
      req.user = user;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/** The identity no directory entry carries — an OIDC `sub`, in shape */
const STRANGER = 'auth0|6a3f9c1e-not-a-uid';

describe('An authenticated identity the model cannot resolve', function () {
  let previous: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(() => {
    previous = process.env.DM_AUTHZ_UNRESOLVED_USER;
  });

  after(() => {
    if (previous === undefined) delete process.env.DM_AUTHZ_UNRESOLVED_USER;
    else process.env.DM_AUTHZ_UNRESOLVED_USER = previous;
  });

  /** A server whose only authorization plugin resolves against the directory */
  const build = async (
    policy?: string
  ): Promise<{
    server: DM;
    request: ReturnType<typeof supertest>;
    authz: AuthzLinid1;
  }> => {
    if (policy === undefined) delete process.env.DM_AUTHZ_UNRESOLVED_USER;
    else process.env.DM_AUTHZ_UNRESOLVED_USER = policy;
    const server = new DM();
    await server.ready;
    server.config.ldap_flat_schema = ['./static/schemas/twake/users.json'];
    const authz = new AuthzLinid1(server);
    await server.registerPlugin('testAuth', new TestAuthPlugin(server));
    await server.registerPlugin('authzLinid1', authz);
    await server.registerPlugin('ldapFlatGeneric', new LdapFlatGeneric(server));
    server.setupErrorMiddleware();
    return { server, request: supertest(server.app), authz };
  };

  it('should refuse a read rather than let it through', async () => {
    const { request } = await build();
    const res = await request
      .get('/api/v1/ldap/users')
      .set('X-Test-User', STRANGER);
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
    expect(res.body.error).to.equal(
      'Token does not have permission on this branch'
    );
  });

  it('should refuse a delete the same way', async () => {
    // A delete rather than a create: the schema computes half the payload of
    // a create, and a refusal on validation would say nothing about who was
    // allowed to write.
    const { request } = await build();
    const res = await request
      .delete('/api/v1/ldap/users/whoever')
      .set('X-Test-User', STRANGER);
    expect(res.status, JSON.stringify(res.body)).to.equal(403);
  });

  it('should say nothing about the model in the body', async () => {
    // The refusal names the plugin and the identity in the log; the body
    // says only that permission is missing, as every other refusal does.
    const { request } = await build();
    const res = await request
      .get('/api/v1/ldap/users')
      .set('X-Test-User', STRANGER);
    expect(JSON.stringify(res.body)).to.not.match(/authzLinid1|resolve/i);
  });

  it('should let it through when the deployment asks for the old behaviour', async () => {
    // `--authz-unresolved-user allow` is what a deployment that turns out to
    // rely on the skip sets, rather than being rewritten by a patch release.
    const { request } = await build('allow');
    const res = await request
      .get('/api/v1/ldap/users')
      .set('X-Test-User', STRANGER);
    expect(res.status, JSON.stringify(res.body)).to.not.equal(403);
  });

  it('should warn when it lets it through', async () => {
    const { server, request } = await build('allow');
    const warned: string[] = [];
    const realWarn = server.logger.warn.bind(server.logger);
    server.logger.warn = ((message: string) => {
      warned.push(String(message));
      return server.logger;
    }) as unknown as typeof server.logger.warn;
    try {
      await request.get('/api/v1/ldap/users').set('X-Test-User', STRANGER);
    } finally {
      server.logger.warn = realWarn;
    }
    expect(warned.some(m => m.includes(STRANGER))).to.equal(true);
  });

  it('should look the identity up once, not once per request', async () => {
    // A mismatch would otherwise turn every request into a directory search:
    // a configuration mistake should not also become a load problem.
    const { server, request, authz } = await build();
    let lookups = 0;
    const realResolve = authz.resolveUser.bind(authz);
    authz.resolveUser = async (uid: string) => {
      lookups++;
      return realResolve(uid);
    };
    await request.get('/api/v1/ldap/users').set('X-Test-User', STRANGER);
    await request.get('/api/v1/ldap/users').set('X-Test-User', STRANGER);
    expect(lookups).to.equal(1);
    expect(server.loadedPlugins['authzLinid1']).to.equal(authz);
  });

  it('should refuse a policy it does not understand, at startup', async () => {
    // `Allow`, `true` or a trailing space all used to mean `deny` in
    // silence: 403 for everyone, and nothing saying the value was not the
    // one the operator wrote.
    const server = new DM();
    await server.ready;
    server.config.authz_unresolved_user = 'Allow';
    expect(() => new AuthzLinid1(server)).to.throw(
      /unknown --authz-unresolved-user "Allow"\. Known: deny, allow/
    );
  });

  it('should stop resolving to a DN the administrator has left', async () => {
    // A positive answer goes stale too: `authzLinid1` resolves an identity
    // to a DN, so an administrator whose entry is renamed keeps resolving to
    // the former one — where no organization names them — and every
    // operation of theirs is refused until the TTL runs out. A rename drops
    // what was resolved.
    const { server, authz, request } = await build();
    let lookups = 0;
    const realResolve = authz.resolveUser.bind(authz);
    authz.resolveUser = async (uid: string) => {
      lookups++;
      return realResolve(uid);
    };
    await request.get('/api/v1/ldap/users').set('X-Test-User', STRANGER);
    expect(lookups).to.equal(1);
    const renamed = server.hooks.ldaprenamedone as
      | ((args: [string, string]) => void)[]
      | undefined;
    for (const hook of renamed ?? []) hook(['uid=a,dc=x', 'uid=b,dc=x']);
    await request.get('/api/v1/ldap/users').set('X-Test-User', STRANGER);
    expect(lookups, 'the rename dropped what was resolved').to.equal(2);
  });

  it('should still skip a request that carries no identity at all', async () => {
    // Anonymous is not unresolvable: nothing authenticated, nothing to
    // resolve, and the route's own authentication answers that.
    const { request } = await build();
    const res = await request.get('/api/v1/ldap/users');
    expect(res.status).to.equal(401);
  });
});
