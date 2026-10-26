import { createServer, type AddressInfo } from 'net';

import { expect } from 'chai';
import supertest from 'supertest';
import express from 'express';
import type { Response } from 'express';

import { DM } from '../../src/bin';
import DmPlugin, { type Role } from '../../src/abstract/plugin';
import AuthBase, { type DmRequest } from '../../src/lib/auth/base';
import {
  PROBE_TTL_MS,
  mountHealth,
  readiness,
  type HealthStatus,
  type Probed,
} from '../../src/lib/health';
import { LDAP_ENV_VARS, skipIfMissingEnvVars } from '../helpers/env';

const never = (): Promise<never> => new Promise(() => undefined);
const later = <T>(ms: number, value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), ms));

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

  it('asks the directory and the plugins at once, within the one timeout', async () => {
    // One after the other, three of them would take 150 ms
    const slow = { health: (): Promise<HealthStatus> => later(50, 'ok') };
    const server = probed([true], { a: slow, b: slow, c: slow });
    const started = Date.now();
    const answer = await readiness(server, started, 1000);
    expect(answer.status).to.equal('ok');
    expect(Date.now() - started, 'three slow plugins, one wait').to.be.below(
      140
    );
  });

  it('serves one answer per interval, whatever it was', async () => {
    const server = probed([false, true]);
    const now = Date.now();
    expect((await readiness(server, now)).status).to.equal('unavailable');
    expect((await readiness(server, now + PROBE_TTL_MS - 1)).status).to.equal(
      'unavailable'
    );
    expect(server.pings).to.equal(1);
    expect((await readiness(server, now + PROBE_TTL_MS)).status).to.equal('ok');
    expect(server.pings).to.equal(2);
  });

  it('asks again when the clock stepped back', async () => {
    const server = probed([false, true]);
    const now = Date.now();
    expect((await readiness(server, now)).status).to.equal('unavailable');
    expect((await readiness(server, now - 3_600_000)).status).to.equal('ok');
    expect(server.pings).to.equal(2);
  });

  it('shares one probe between the probes arriving meanwhile', async () => {
    const counting = { calls: 0, health: (): HealthStatus => 'ok' };
    counting.health = (): HealthStatus => {
      counting.calls++;
      return 'ok';
    };
    const server = probed(['hangs'], { counting });
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
    expect(counting.calls).to.equal(1);
  });
});

describe('Readiness route on a bare application', () => {
  const mounted = (server: Probed): ReturnType<typeof supertest> => {
    const app = express();
    mountHealth(app, server);
    return supertest(app);
  };

  it('answers 503 while starting', async () => {
    const res = await mounted(probed([true], {}, false)).get('/readyz');
    expect(res.status).to.equal(503);
    expect(res.body).to.deep.equal({ status: 'starting' });
  });

  it('answers 503 when the directory does not answer', async () => {
    const res = await mounted(probed([false])).get('/readyz');
    expect(res.status).to.equal(503);
    expect(res.body).to.deep.equal({ status: 'unavailable', ldap: 'failed' });
  });

  it('answers 200 when degraded', async () => {
    const res = await mounted(
      probed([true], { queue: { health: (): HealthStatus => 'degraded' } })
    ).get('/readyz');
    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal('degraded');
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

  it('answers /readyz 200 on a directory that answers, with what the plugins report', async () => {
    class Degraded extends DmPlugin {
      name = 'degraded';
      health(): HealthStatus {
        return 'degraded';
      }
    }
    // Before the first probe: its answer serves the tests that follow
    await server.registerPlugin('degraded', new Degraded(server));
    try {
      const res = await request.get('/readyz');
      expect(res.status, JSON.stringify(res.body)).to.equal(200);
      expect(res.body.ldap).to.equal('ok');
      expect(res.body.status).to.equal('degraded');
      expect(res.body.plugins).to.deep.equal({ degraded: 'degraded' });
    } finally {
      delete server.loadedPlugins.degraded;
    }
  });

  it('pings the directory on a connection of its own, and fails on a closed port', async () => {
    await server.ldap.ping(2000);
    const urls = server.ldap['ldapUrls'];
    server.ldap['ldapUrls'] = ['ldap://127.0.0.1:1'];
    try {
      await server.ldap.ping(2000).then(
        () => expect.fail('answered on a closed port'),
        (err: Error) => expect(err.message).to.match(/No directory answered/)
      );
    } finally {
      server.ldap['ldapUrls'] = urls;
    }
  });

  it('gives up on a directory that accepts the connection and never answers', async () => {
    const mute = createServer(() => undefined);
    await new Promise<void>(resolve => mute.listen(0, '127.0.0.1', resolve));
    const { port } = mute.address() as AddressInfo;
    const urls = server.ldap['ldapUrls'];
    server.ldap['ldapUrls'] = [`ldap://127.0.0.1:${port}`];
    const started = Date.now();
    try {
      await server.ldap.ping(300).then(
        () => expect.fail('answered by a mute directory'),
        (err: Error) => expect(err.message).to.match(/No directory answered/)
      );
      expect(Date.now() - started, 'within the budget').to.be.below(2000);
    } finally {
      server.ldap['ldapUrls'] = urls;
      mute.close();
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
      // Scoped to the API: the probes are the only routes outside it here
      class Scoped extends Refusing {
        name = 'scoped';
        get pathPrefixes(): string[] {
          return ['/api'];
        }
      }
      const refusing = server.loadedPlugins.refusing;
      delete server.loadedPlugins.refusing;
      server.loadedPlugins.scoped = new Scoped(server);
      try {
        expect(server.warnUnauthenticatedRoutes()).to.deep.equal([]);
      } finally {
        delete server.loadedPlugins.scoped;
        server.loadedPlugins.refusing = refusing;
      }
    });
  });
});
