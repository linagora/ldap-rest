import request from 'supertest';
import { expect } from 'chai';

import { DM } from '../../../src/bin';

/**
 * The same scoping, exercised through the real plugin loader rather than
 * through `registerPlugin` calls written in the right order by hand.
 *
 * This is the path the authentication bypass lived on: `loadPlugin` matches
 * the priority list by exact string, so a named instance — the only form that
 * can carry a scope — never gets the sequential early load and lands in the
 * parallel batch, where an API plugin can register its routes first. The API
 * is deliberately declared before the plugin that guards it.
 */
describe('Authentication path scope through the plugin loader', () => {
  let dm: DM;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DM_AUTH_TOKENS = '';
    // `;` separates plugins, since the override JSON contains commas
    process.env.DM_PLUGINS = [
      '../../dist/plugins/demo/helloworld.js:helloAdmin:{"api_prefix":"/api/admin"}',
      '../../dist/plugins/auth/token.js:authAdmins:{"auth_path_prefix":"/api/admin","auth_token":["admtok:admins"]}',
      '../../dist/plugins/auth/token.js:authRest:{"auth_token":["resttok:rest"]}',
    ].join(';');

    dm = new DM();
    await dm.ready;
  });

  after(() => {
    delete process.env.NODE_ENV;
    delete process.env.DM_PLUGINS;
    delete process.env.DM_AUTH_TOKENS;
  });

  it('should load both authentications', () => {
    expect(Object.keys(dm.loadedPlugins)).to.include('authAdmins');
    expect(Object.keys(dm.loadedPlugins)).to.include('authRest');
    expect(dm.authenticators).to.have.length(2);
  });

  it('should guard the branch whose plugin was declared after its API', async () => {
    expect((await request(dm.app).get('/api/admin/hello')).status).to.equal(
      401
    );
  });

  it('should accept the credential scoped to that branch', async () => {
    const res = await request(dm.app)
      .get('/api/admin/hello')
      .set('Authorization', 'Bearer admtok');
    expect(res.status).to.equal(200);
    expect(res.body.message).to.equal('Hello');
  });

  it('should refuse the catch-all credential on that branch', async () => {
    const res = await request(dm.app)
      .get('/api/admin/hello')
      .set('Authorization', 'Bearer resttok');
    expect(res.status).to.equal(401);
  });

  it('should let the catch-all guard everything else', async () => {
    // No route there, but authentication answers before the 404
    expect((await request(dm.app).get('/api/whatever')).status).to.equal(401);
    expect(
      (
        await request(dm.app)
          .get('/api/whatever')
          .set('Authorization', 'Bearer resttok')
      ).status
    ).to.equal(404);
  });
});
