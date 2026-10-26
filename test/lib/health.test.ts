import { expect } from 'chai';
import supertest from 'supertest';
import type { Response } from 'express';

import { DM } from '../../src/bin';
import DmPlugin, { type Role } from '../../src/abstract/plugin';
import AuthBase, { type DmRequest } from '../../src/lib/auth/base';
import {
  LDAP_PROBE_TTL_MS,
  readiness,
  type HealthStatus,
  type Probed,
} from '../../src/lib/health';
import { LDAP_ENV_VARS, skipIfMissingEnvVars } from '../helpers/env';

const never = (): Promise<never> => new Promise(() => undefined);

/** A server whose directory answers as `answers` says, probe after probe */
const probed = (
  answers: Array<boolean | 'hangs'>,
  plugins: Probed['loadedPlugins'] = {},
  composed = true
): Probed & { pings: number } => {
  const server = {
    composed,
    pings: 0,
    loadedPlugins: plugins,
    ldap: {
      ping: async (): Promise<void> => {
        const answer = answers[Math.min(server.pings, answers.length - 1)];
        server.pings++;
        if (answer === 'hangs') return never();
        if (!answer) throw new Error('connection refused');
      },
    },
  };
  return server;
};

describe('Readiness', () => {
  it('is starting until the plugins are loaded', async () => {
    const server = probed([true], {}, false);
    expect(await readiness(server)).to.deep.equal({ status: 'starting' });
    expect(server.pings, 'no directory probe before').to.equal(0);
  });

  it('is unavailable when the directory does not answer', async () => {
    expect(await readiness(probed([false]))).to.deep.equal({
      status: 'unavailable',
      ldap: 'failed',
    });
  });

  it('is unavailable when the directory does not answer in time', async () => {
    expect(await readiness(probed(['hangs']), Date.now(), 20)).to.deep.equal({
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

  it('is degraded when a plugin says so, cannot say or does not answer in time', async () => {
    const answer = await readiness(
      probed([true], {
        fine: { health: (): HealthStatus => 'ok' },
        queue: { health: async (): Promise<HealthStatus> => 'degraded' },
        broken: {
          health: (): HealthStatus => {
            throw new Error('no answer');
          },
        },
        stuck: { health: never },
        silent: {},
      }),
      Date.now(),
      20
    );
    expect(answer).to.deep.equal({
      status: 'degraded',
      ldap: 'ok',
      plugins: {
        fine: 'ok',
        queue: 'degraded',
        broken: 'failed',
        stuck: 'failed',
      },
    });
  });

  it('asks the directory once per interval, whatever it answered', async () => {
    const server = probed([false, true]);
    const now = Date.now();
    expect((await readiness(server, now)).status).to.equal('unavailable');
    expect(
      (await readiness(server, now + LDAP_PROBE_TTL_MS - 1)).status
    ).to.equal('unavailable');
    expect(server.pings).to.equal(1);
    expect((await readiness(server, now + LDAP_PROBE_TTL_MS)).status).to.equal(
      'ok'
    );
    expect(server.pings).to.equal(2);
  });

  it('shares one directory probe between the probes arriving meanwhile', async () => {
    const server = probed(['hangs']);
    const now = Date.now();
    const answers = await Promise.all([
      readiness(server, now, 20),
      readiness(server, now + 1, 20),
      readiness(server, now + 2, 20),
    ]);
    expect(answers.map(a => a.status)).to.deep.equal([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(server.pings).to.equal(1);
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

  describe('behind an authentication guarding every path', () => {
    class Refusing extends AuthBase {
      name = 'refusing';
      roles: Role[] = ['auth'];
      authMethod(_req: DmRequest, res: Response): void {
        res.status(401).json({ error: 'Unauthorized' });
      }
    }

    before(async () => {
      await server.registerPlugin('refusing', new Refusing(server));
    });

    after(() => {
      delete server.loadedPlugins.refusing;
    });

    it('still answers the probes, and nothing else', async () => {
      expect((await request.get('/healthz')).status).to.equal(200);
      expect((await request.get('/readyz')).status).to.equal(200);
      expect((await request.get('/api/v1/ldap/users')).status).to.equal(401);
    });

    it('leaves the probes out of the unauthenticated routes it warns about', () => {
      const unguarded = server.warnUnauthenticatedRoutes();
      expect(unguarded).not.to.include('/healthz');
      expect(unguarded).not.to.include('/readyz');
    });
  });
});
