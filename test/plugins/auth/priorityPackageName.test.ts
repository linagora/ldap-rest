/**
 * A plugin named by its package keeps its rank in the priority list
 * (GHSA-98fh-j3x2-c347).
 *
 * `priority.json` matches on the module the configuration wrote. A plugin
 * that has a package can be named either way, and only the `core/…` spelling
 * was listed: `--plugin @ldap-rest/auth-trustedproxy` matched no entry, went
 * to the parallel batch, and registered after the routes it guards — the
 * same hole a named instance used to leave.
 *
 * See `test/plugins/auth/priorityNamedInstance.test.ts` for the probe.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../helpers/dm';

const PROBE = '../../test/fixtures/plugins/xffProbe.js';
const TRUSTED_PROXY = '@ldap-rest/auth-trustedproxy';

describe('Priority plugins named by their package', function () {
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of ['DM_PLUGINS', 'DM_TRUSTED_PROXIES', 'NODE_ENV'])
      saved[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    // A network the test client is not on, so the header must be stripped.
    process.env.DM_TRUSTED_PROXIES = '10.99.0.1';
  });

  after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  const forgedHeaderSeenBy = async (plugins: string[]): Promise<unknown> => {
    process.env.DM_PLUGINS = plugins.join(';');
    const server = new DM();
    await server.ready;
    const res = await supertest(server.app)
      .get('/api/xff-probe')
      .set('X-Forwarded-For', '1.2.3.4');
    return res.body.xff;
  };

  it('should strip a forged header for a package spelling', async () => {
    expect(await forgedHeaderSeenBy([PROBE, TRUSTED_PROXY])).to.equal(null);
  });

  it('should strip it for a named instance of a package spelling', async () => {
    expect(await forgedHeaderSeenBy([PROBE, `${TRUSTED_PROXY}:tp2`])).to.equal(
      null
    );
  });
});
