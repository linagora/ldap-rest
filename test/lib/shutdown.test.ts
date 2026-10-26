import { Agent, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { expect } from 'chai';
import supertest from 'supertest';
import type { Express, Request, Response } from 'express';

import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';

/** A request on a keep-alive connection, answered when the server answers */
const get = (
  port: number,
  url: string
): Promise<{ status: number; connection?: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { port, path: url, method: 'GET', agent: keepAlive },
      res => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            connection: res.headers.connection,
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });

const keepAlive = new Agent({ keepAlive: true });

describe('Shutdown', function () {
  this.timeout(20000);
  after(() => keepAlive.destroy());
  let server: DM;
  let port: number;
  const closed: string[] = [];
  let release: () => void = () => undefined;

  before(async () => {
    server = new DM();
    await server.ready;
    server.config.port = 0;
    server.config.shutdown_timeout = 8000;
    class Holding extends DmPlugin {
      name = 'holding';
      api(app: Express): void {
        app.get('/slow', async (_req: Request, res: Response) => {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          res.json({ done: true });
        });
      }
      async close(): Promise<void> {
        closed.push('holding');
      }
    }
    class Failing extends DmPlugin {
      name = 'failing';
      close(): void {
        closed.push('failing');
        throw new Error('nothing to let go');
      }
    }
    await server.registerPlugin('holding', new Holding(server));
    await server.registerPlugin('failing', new Failing(server));
    server.setupErrorMiddleware();
    await server.run();
    port = (server.server!.address() as { port: number }).port;
  });

  it('finishes what is in flight, says it is stopping, then lets go', async () => {
    const slow = get(port, '/slow');
    // The request is in: the route holds it until released
    await new Promise(resolve => setTimeout(resolve, 100));
    const stopping = server.shutdown();
    expect(server.stopping).to.equal(true);
    const probe = await supertest(server.app).get('/readyz');
    expect(probe.status).to.equal(503);
    expect(probe.body).to.deep.equal({ status: 'stopping' });
    // Nothing new is taken while the request in flight finishes
    await get(port, '/healthz').then(
      () => expect.fail('a new connection was taken'),
      () => undefined
    );
    expect(closed, 'nothing let go before the drain').to.deep.equal([]);
    release();
    const { status, connection } = await slow;
    expect(status).to.equal(200);
    expect(connection, 'the connection closes with the response').to.equal(
      'close'
    );
    const released = Date.now();
    await stopping;
    expect(
      Date.now() - released,
      'the drain ends with the response'
    ).to.be.below(1500);
    expect(closed.sort()).to.deep.equal(['failing', 'holding']);
    expect(
      await server.shutdown(),
      'a second call waits for the first'
    ).to.equal(undefined);
  });
});

describe('Crash policy', function () {
  this.timeout(30000);

  it('shuts down and exits with 1 on an uncaught exception', async () => {
    const child = path.join(__dirname, '..', 'fixtures', 'crashChild.ts');
    const out = await new Promise<{ code: number | null; lines: string[] }>(
      (resolve, reject) => {
        const proc = spawn(process.execPath, ['--import', 'tsx', child], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const lines: string[] = [];
        const keep = (chunk: Buffer): void => {
          for (const line of chunk.toString().split('\n').filter(Boolean))
            lines.push(line);
        };
        proc.stdout.on('data', keep);
        proc.stderr.on('data', keep);
        proc.on('error', reject);
        proc.on('exit', code => resolve({ code, lines }));
      }
    );
    expect(out.code, out.lines.join('\n')).to.equal(1);
    expect(out.lines.some(l => /Uncaught exception: boom/.test(l))).to.equal(
      true
    );
    expect(
      out.lines.some(l => /closed/.test(l)),
      'the plugin let go'
    ).to.equal(true);
  });
});
