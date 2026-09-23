/**
 * Where the deferred verdict runs (GHSA-rxq9-qj94-27gg, review of #192).
 *
 * A bypass names the identity another authenticator publishes, so a request
 * carrying no token of ours cannot be judged until the whole chain has run.
 * The first shape of that deferral put the verdict in a middleware mounted
 * in `api()` — and `authzDynamic` is not in `priority.json`, so it lands in
 * the parallel batch where registration order is import-completion order: a
 * route plugin registered first answered *before* the refusal, with no token
 * on the request and no async-context frame, so the hooks enforced nothing
 * either. The refusal was lost, not late, and registration order decided an
 * authorization answer again — failing open this time.
 *
 * The verdict lives in the dispatcher now, which `DM` mounts before any
 * plugin loads. This suite drives the real loader, which is the only place
 * the difference shows.
 *
 * Both declaration orders are run, and on the previous head **both** failed:
 * neither is the determinant. Plugins outside `priority.json` are loaded by
 * `Promise.all`, so what decides is import completion — the demo plugin
 * imports in a moment, `authzDynamic` pulls in ldapts — and the route landed
 * first whichever way round the configuration named them. That is the
 * argument for the dispatcher rather than for a priority entry: the order
 * cannot be written down, so nothing may depend on it.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

const ROUTE_PLUGIN = '../../dist/plugins/demo/helloworld.js';
const AUTHZ_PLUGIN = '../../dist/plugins/auth/authzDynamic.js';

describe('authzDynamic, deferred verdict and route order', function () {
  const saved: Record<string, string | undefined> = {};
  let baseDn: string;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(() => {
    baseDn = process.env.DM_LDAP_BASE as string;
    for (const k of [
      'DM_PLUGINS',
      'DM_AUTHZ_DYNAMIC_BASE',
      'DM_AUTHZ_DYNAMIC_BYPASS',
      'NODE_ENV',
    ])
      saved[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    // A branch with no token entry: what matters here is the verdict on a
    // request carrying no token at all.
    process.env.DM_AUTHZ_DYNAMIC_BASE = `ou=authz-deferral-tokens,${baseDn}`;
    // A non-empty list is what makes the plugin defer instead of refusing
    // on the spot.
    process.env.DM_AUTHZ_DYNAMIC_BYPASS = 'alice';
  });

  after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  const startWith = async (plugins: string[]): Promise<DM> => {
    process.env.DM_PLUGINS = plugins.join(';');
    const server = new DM();
    await server.ready;
    return server;
  };

  for (const routeFirst of [true, false]) {
    const order = routeFirst ? 'route plugin first' : 'authzDynamic first';

    it(`should refuse a request no bypass covers (${order})`, async () => {
      const plugins = routeFirst
        ? [ROUTE_PLUGIN, AUTHZ_PLUGIN]
        : [AUTHZ_PLUGIN, ROUTE_PLUGIN];
      const server = await startWith(plugins);
      const res = await supertest(server.app).get('/api/hello');
      expect(res.status, JSON.stringify(res.body)).to.equal(401);
      expect(res.body.message, 'the route must not have answered').to.equal(
        undefined
      );
    });
  }
});
