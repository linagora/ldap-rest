/**
 * A named instance keeps its rank in the priority list
 * (GHSA-98fh-j3x2-c347).
 *
 * `priority.json` names modules and the loader compared them against the
 * whole `--plugin` string, so `core/auth/trustedProxy:tp2:{…}` — the only
 * form that can carry a per-instance option — was never equal to the bare
 * module and fell into the parallel batch, where the order is import
 * completion. The plugin then registered *after* the routes it guards, and
 * a forged `X-Forwarded-For` reached them: `rateLimit` and `crowdsec` key
 * their protection on that header, and `trustedProxy` is what makes it
 * trustworthy.
 *
 * The probe below echoes the header as the route sees it. Its own module is
 * not in the priority list, so it is loaded in the parallel batch — which is
 * exactly where a named priority plugin must not end up.
 */
import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../../src/bin';
import pluginPriority from '../../../src/plugins/priority.json';

const PROBE = '../../test/fixtures/plugins/xffProbe.js';
const TRUSTED_PROXY = '../../dist/plugins/auth/trustedProxy.js';

describe('Priority plugins configured with a name', function () {
  const saved: Record<string, string | undefined> = {};

  before(() => {
    for (const k of ['DM_PLUGINS', 'DM_TRUSTED_PROXIES', 'NODE_ENV'])
      saved[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    // A network the test client is not on, so the header must be stripped.
    process.env.DM_TRUSTED_PROXIES = '10.99.0.1';
    // `core/…` resolves against the running build, which is `src` under the
    // test runner, while a plugin can only be loaded here from `dist`. So
    // the list is given the spelling this suite uses — what is under test is
    // the matching, which is what stopped recognising a named instance.
    pluginPriority.push(TRUSTED_PROXY);
  });

  after(() => {
    pluginPriority.splice(pluginPriority.indexOf(TRUSTED_PROXY), 1);
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

  it('should strip a forged header for an unnamed instance', async () => {
    expect(await forgedHeaderSeenBy([PROBE, TRUSTED_PROXY])).to.equal(null);
  });

  it('should strip it for a named instance too', async () => {
    // The case that was open: the name and the overrides are what a
    // deployment needs to guard one prefix differently, and they used to
    // cost the plugin its rank.
    expect(
      await forgedHeaderSeenBy([
        PROBE,
        `${TRUSTED_PROXY}:tp2:{"trusted_proxy":["10.99.0.1"]}`,
      ])
    ).to.equal(null);
  });

  it('should strip it for an instance named without overrides', async () => {
    expect(await forgedHeaderSeenBy([PROBE, `${TRUSTED_PROXY}:tp3`])).to.equal(
      null
    );
  });
});
