/**
 * The plugin has to load the way a deployment loads it.
 *
 * Every OIDC suite here imports the plugin statically and hands it to
 * `registerPlugin`, and the test runner's CommonJS interop is lenient about
 * named imports. The loader's dynamic `import()` — the only path a
 * deployment takes — is not: `express-openid-connect` is CommonJS, Node
 * reads its `module.exports` statically to decide which names an ESM file
 * may import, and a property arriving through a spread is invisible to it.
 * So `import { requiresAuth } from 'express-openid-connect'` type-checks,
 * passes every suite, and fails at startup with
 * `Named export 'requiresAuth' not found`.
 *
 * Any plugin whose dependency is CommonJS is one named import away from
 * that, and only the loader sees it.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';

/** As the loader spells it: relative to `src/bin`, which resolves it */
const PLUGIN = '../../dist/plugins/auth/openidconnect.js';
/** The same file, spelled from here */
const BUILT = '../../../dist/plugins/auth/openidconnect.js';

describe('OpenID Connect through the plugin loader', function () {
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of [
      'DM_PLUGINS',
      'DM_OIDC_SERVER',
      'DM_OIDC_CLIENT_ID',
      'DM_OIDC_CLIENT_SECRET',
      'DM_BASE_URL',
    ])
      saved[k] = process.env[k];
    process.env.DM_OIDC_SERVER = 'http://oidc.example.test';
    process.env.DM_OIDC_CLIENT_ID = 'client';
    process.env.DM_OIDC_CLIENT_SECRET = 'a-secret-long-enough-for-the-library';
    process.env.DM_BASE_URL = 'http://localhost:3000';
  });

  after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('should be loadable by the loader, dependency and all', async () => {
    // The built file, imported dynamically: `npm run build` is what CI runs
    // before the suite, and what a deployment installs.
    const module = (await import(BUILT)) as { default?: unknown };
    expect(typeof module.default).to.equal('function');
  });

  it('should start a server that declares it', async () => {
    process.env.DM_PLUGINS = PLUGIN;
    const server = new DM();
    await server.ready;
    expect(Object.keys(server.loadedPlugins)).to.include('openidconnect');
  });
});
