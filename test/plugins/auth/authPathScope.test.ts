import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import AuthToken from '../../../src/plugins/auth/token';
import HelloWorld from '../../../src/plugins/demo/helloworld';

/**
 * Scoping authentication to a path prefix is what lets a single server host
 * machines authenticating with a token and administrators authenticating
 * with an SSO session, without either credential being valid on the other's
 * branch of the API.
 *
 * The setup mirrors the documented deployment: one API instance and one
 * authentication instance per branch, all in one server.
 */
describe('Authentication path scope', () => {
  const machineToken = 'machine-token';
  const adminToken = 'admin-token';

  interface Scope {
    name: string;
    token: string;
    /** A bare string is what a plugin override carries: `"/api/m"` */
    prefix?: string | string[];
  }

  /**
   * Build a server with one token plugin per scope and one hello API per
   * prefix, plus an unscoped hello API on the default prefix.
   *
   * @param scopes prefix and token of each authentication instance
   * @returns the Express app and the DM instance
   */
  async function build(scopes: Scope[]): Promise<{ app: Express; dm: DM }> {
    const dm = new DM();
    await dm.ready;

    /** Clone the server with an overridden configuration, as loadPlugin does */
    const withConfig = (overrides: Record<string, unknown>): DM =>
      ({ ...dm, config: { ...dm.config, ...overrides } }) as DM;

    for (const scope of scopes) {
      const plugin = new AuthToken(
        withConfig({
          auth_token: [`${scope.token}:${scope.name}`],
          auth_path_prefix: scope.prefix,
        })
      );
      // The name must be passed explicitly: registerPlugin keeps the one
      // declared by the class otherwise, and the second instance is dropped
      await dm.registerPlugin('core/auth/token', plugin, scope.name);
    }

    for (const scope of scopes)
      for (const prefix of typeof scope.prefix === 'string'
        ? [scope.prefix]
        : scope.prefix || [])
        await dm.registerPlugin(
          'core/demo/helloworld',
          new HelloWorld(withConfig({ api_prefix: prefix })),
          `hello${prefix}`
        );

    // An API left on the default prefix, outside every scope
    await dm.registerPlugin(
      'core/demo/helloworld',
      new HelloWorld(dm),
      'hello'
    );
    return { app: dm.app, dm };
  }

  describe('a single scoped plugin', () => {
    let app: Express;
    let dm: DM;

    before(async () => {
      ({ app, dm } = await build([
        { name: 'authMachines', token: machineToken, prefix: ['/api/m'] },
      ]));
    });

    it('should protect its own prefix', async () => {
      const res = await request(app).get('/api/m/hello');
      expect(res.status).to.equal(401);
    });

    it('should accept its token on that prefix', async () => {
      const res = await request(app)
        .get('/api/m/hello')
        .set('Authorization', `Bearer ${machineToken}`);
      expect(res.status).to.equal(200);
      expect(res.body.message).to.equal('Hello');
    });

    it('should leave routes outside the prefix unauthenticated', async () => {
      const res = await request(app).get('/api/hello');
      expect(res.status).to.equal(200);
    });

    it('should name the routes it does not guard', () => {
      const unguarded = dm.warnUnauthenticatedRoutes();
      expect(unguarded).to.contain('/api/hello');
      expect(unguarded).to.not.contain('/api/m/hello');
    });
  });

  describe('prefix boundaries', () => {
    let app: Express;

    before(async () => {
      ({ app } = await build([
        { name: 'authBoundary', token: machineToken, prefix: ['/api/m'] },
      ]));
    });

    it('should guard every path below the prefix', async () => {
      expect((await request(app).get('/api/m/hello')).status).to.equal(401);
      expect((await request(app).get('/api/m/anything')).status).to.equal(401);
      expect((await request(app).get('/api/m')).status).to.equal(401);
    });

    it('should not guard a path that merely starts with the same letters', async () => {
      // `/api/machines` is not below `/api/m`
      expect((await request(app).get('/api/machines')).status).to.equal(404);
    });

    it('should ignore a trailing slash in the configuration', async () => {
      const { app: trailing } = await build([
        { name: 'authTrailing', token: machineToken, prefix: ['/api/m/'] },
      ]);
      expect((await request(trailing).get('/api/m/hello')).status).to.equal(
        401
      );
    });

    it('should accept a single prefix given as a bare string', async () => {
      // The form the documented plugin override produces:
      // --plugin 'core/auth/token:tok:{"auth_path_prefix":"/api/m"}'
      const { app: single } = await build([
        { name: 'authString', token: machineToken, prefix: '/api/m' },
      ]);
      expect((await request(single).get('/api/m/hello')).status).to.equal(401);
      expect((await request(single).get('/api/hello')).status).to.equal(200);
    });

    it('should accept several prefixes', async () => {
      const { app: multi } = await build([
        {
          name: 'authMulti',
          token: machineToken,
          prefix: ['/api/m', '/api/n'],
        },
      ]);
      expect((await request(multi).get('/api/m/hello')).status).to.equal(401);
      expect((await request(multi).get('/api/n/hello')).status).to.equal(401);
      expect((await request(multi).get('/api/hello')).status).to.equal(200);
    });
  });

  describe('two populations on one server', () => {
    let app: Express;

    before(async () => {
      ({ app } = await build([
        { name: 'authMachines', token: machineToken, prefix: ['/api/m'] },
        { name: 'authAdmins', token: adminToken, prefix: ['/api/admin'] },
      ]));
    });

    it('should accept each token on its own branch', async () => {
      const machines = await request(app)
        .get('/api/m/hello')
        .set('Authorization', `Bearer ${machineToken}`);
      expect(machines.status).to.equal(200);

      const admins = await request(app)
        .get('/api/admin/hello')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(admins.status).to.equal(200);
    });

    it('should refuse a credential outside its branch', async () => {
      // The whole point of scoping: a leaked machine token buys nothing on
      // the administration API
      const crossed = await request(app)
        .get('/api/admin/hello')
        .set('Authorization', `Bearer ${machineToken}`);
      expect(crossed.status).to.equal(401);

      const other = await request(app)
        .get('/api/m/hello')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(other.status).to.equal(401);
    });

    it('should refuse a request with no credential on either branch', async () => {
      expect((await request(app).get('/api/m/hello')).status).to.equal(401);
      expect((await request(app).get('/api/admin/hello')).status).to.equal(401);
    });
  });

  describe('unscoped plugins', () => {
    it('should keep guarding every path', async () => {
      const { app } = await build([
        { name: 'authGlobal', token: machineToken },
      ]);
      expect((await request(app).get('/api/hello')).status).to.equal(401);
      expect(
        (
          await request(app)
            .get('/api/hello')
            .set('Authorization', `Bearer ${machineToken}`)
        ).status
      ).to.equal(200);
    });

    it('should report nothing, since no route is left out', async () => {
      const { dm } = await build([
        { name: 'authGlobal2', token: machineToken },
      ]);
      expect(dm.warnUnauthenticatedRoutes()).to.deep.equal([]);
    });

    it('should report nothing when no authentication is configured', async () => {
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('core/demo/helloworld', new HelloWorld(dm));
      expect(dm.warnUnauthenticatedRoutes()).to.deep.equal([]);
    });

    it('should report nothing when one plugin guards everything', async () => {
      const { dm } = await build([
        { name: 'authScoped', token: machineToken, prefix: ['/api/m'] },
        { name: 'authEverything', token: adminToken },
      ]);
      expect(dm.warnUnauthenticatedRoutes()).to.deep.equal([]);
    });
  });
});
