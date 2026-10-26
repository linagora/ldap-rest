import { expect } from 'chai';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';
import {
  LDAP_PROBE_TTL_MS,
  readiness,
  type HealthStatus,
  type Probed,
} from '../../src/lib/health';
import { LDAP_ENV_VARS, skipIfMissingEnvVars } from '../helpers/env';

/** A server whose directory answers as `answers` says, probe after probe */
const probed = (
  answers: boolean[],
  plugins: Probed['loadedPlugins'] = {},
  composed = true
): Probed & { searches: number } => {
  const server = {
    composed,
    config: { ldap_base: 'dc=example,dc=com' },
    searches: 0,
    loadedPlugins: plugins,
    ldap: {
      system: {
        search: async (): Promise<unknown> => {
          const ok = answers[Math.min(server.searches, answers.length - 1)];
          server.searches++;
          if (!ok) throw new Error('connection refused');
          return { searchEntries: [{}] };
        },
      },
    },
  };
  return server;
};

describe('Readiness', () => {
  it('is starting until the plugins are loaded', async () => {
    const server = probed([true], {}, false);
    expect(await readiness(server)).to.deep.equal({ status: 'starting' });
    expect(server.searches, 'no directory probe before').to.equal(0);
  });

  it('is unavailable when the directory does not answer', async () => {
    expect(await readiness(probed([false]))).to.deep.equal({
      status: 'unavailable',
      ldap: 'failed',
    });
  });

  it('is ok when the directory answers and no plugin reports', async () => {
    expect(await readiness(probed([true]))).to.deep.equal({
      status: 'ok',
      ldap: 'ok',
      plugins: {},
    });
  });

  it('is degraded when a plugin says so or cannot say', async () => {
    const answer = await readiness(
      probed([true], {
        fine: { health: (): HealthStatus => 'ok' },
        queue: { health: async (): Promise<HealthStatus> => 'degraded' },
        broken: {
          health: (): HealthStatus => {
            throw new Error('no answer');
          },
        },
        silent: {},
      })
    );
    expect(answer).to.deep.equal({
      status: 'degraded',
      ldap: 'ok',
      plugins: { fine: 'ok', queue: 'degraded', broken: 'failed' },
    });
  });

  it('asks the directory once per interval, whatever it answered', async () => {
    const server = probed([false, true]);
    const now = Date.now();
    expect((await readiness(server, now)).status).to.equal('unavailable');
    expect(
      (await readiness(server, now + LDAP_PROBE_TTL_MS - 1)).status
    ).to.equal('unavailable');
    expect(server.searches).to.equal(1);
    expect((await readiness(server, now + LDAP_PROBE_TTL_MS)).status).to.equal(
      'ok'
    );
    expect(server.searches).to.equal(2);
  });
});

describe('Health routes', function () {
  let server: DM;
  let request: ReturnType<typeof supertest>;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    server = new DM();
    await server.ready;
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  it('answers /healthz without authentication', async () => {
    const res = await request.get('/healthz');
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
    expect(res.headers['cache-control']).to.equal('no-store');
  });

  it('answers /readyz 200 on a directory that answers', async () => {
    const res = await request.get('/readyz');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.status).to.equal('ok');
    expect(res.body.ldap).to.equal('ok');
  });

  it('lists a plugin reporting its health', async () => {
    class Degraded extends DmPlugin {
      name = 'degraded';
      health(): HealthStatus {
        return 'degraded';
      }
    }
    await server.registerPlugin('degraded', new Degraded(server));
    try {
      const res = await request.get('/readyz');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.status).to.equal('degraded');
      expect(res.body.plugins).to.deep.equal({ degraded: 'degraded' });
    } finally {
      delete server.loadedPlugins.degraded;
    }
  });

  it('leaves the probes out of the unauthenticated routes it warns about', () => {
    expect(server.warnUnauthenticatedRoutes()).not.to.include.members([
      '/healthz',
      '/readyz',
    ]);
  });
});
