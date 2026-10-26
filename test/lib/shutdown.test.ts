import { Agent, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
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

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** A plugin holding its routes until released, and saying when it let go */
class Holding extends DmPlugin {
  name = 'holding';
  closed: string[] = [];
  release: () => void = () => undefined;
  releaseStream: () => void = () => undefined;
  api(app: Express): void {
    app.get('/slow', async (_req: Request, res: Response) => {
      await new Promise<void>(resolve => {
        this.release = resolve;
      });
      res.json({ done: true });
    });
    // Headers out at once, the end held: a download under way
    app.get('/stream', async (_req: Request, res: Response) => {
      res.write('first');
      await new Promise<void>(resolve => {
        this.releaseStream = resolve;
      });
      res.end('last');
    });
  }
  async close(): Promise<void> {
    this.closed.push('holding');
  }
}

const serve = async (
  timeout: number,
  ...more: DmPlugin[]
): Promise<{ server: DM; port: number; holding: Holding }> => {
  const server = new DM();
  await server.ready;
  server.config.port = 0;
  server.config.shutdown_timeout = timeout;
  const holding = new Holding(server);
  await server.registerPlugin('holding', holding);
  for (const plugin of more) await server.registerPlugin(plugin.name, plugin);
  server.setupErrorMiddleware();
  await server.run();
  return {
    server,
    port: (server.server!.address() as { port: number }).port,
    holding,
  };
};

describe('Shutdown', function () {
  this.timeout(20000);
  after(() => keepAlive.destroy());

  it('finishes what is in flight, says it is stopping, then lets go', async () => {
    const closed: string[] = [];
    class Failing extends DmPlugin {
      name = 'failing';
      close(): void {
        closed.push('failing');
        throw new Error('nothing to let go');
      }
    }
    const { server, port, holding } = await serve(8000, new Failing({} as DM));
    // A pooled directory connection, to be closed with the rest
    await server.ldap.search({ scope: 'one', sizeLimit: 1 });
    const slow = get(port, '/slow');
    // The request is in: the route holds it until released
    await pause(100);
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
    holding.release();
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
    expect([...closed, ...holding.closed].sort()).to.deep.equal([
      'failing',
      'holding',
    ]);
    await server.ldap.search({ scope: 'one', sizeLimit: 1 }).then(
      () => expect.fail('the directory connections are still handed out'),
      (err: Error) => expect(err.message).to.match(/closed/)
    );
    expect(
      await server.shutdown(),
      'a second call waits for the first'
    ).to.equal(undefined);
    expect(holding.closed, 'and lets go once').to.deep.equal(['holding']);
  });

  it('closes a connection whose response had started with that response', async () => {
    const { server, port, holding } = await serve(8000);
    const socket = connect(port);
    await new Promise(resolve => socket.once('connect', resolve));
    let received = '';
    socket.on('data', chunk => (received += chunk.toString()));
    const ended = new Promise<void>(resolve => socket.once('close', resolve));
    socket.write(`GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    await pause(100);
    const stopping = server.shutdown();
    // Pipelined on the connection the stream holds: answered after it
    socket.write(`GET /readyz HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    await pause(100);
    holding.releaseStream();
    const released = Date.now();
    await stopping;
    expect(Date.now() - released, 'the drain ends with the stream').to.be.below(
      1500
    );
    await ended;
    const responses = received.split(/(?=HTTP\/1\.1 )/);
    expect(responses, received).to.have.length(2);
    expect(responses[0]).to.match(/^HTTP\/1\.1 200/);
    expect(responses[0]).to.include('last');
    expect(responses[1]).to.match(/^HTTP\/1\.1 503/);
    expect(responses[1]).to.match(/^Connection: close$/m);
  });

  it('cuts what has not finished when the drain is spent', async () => {
    const { server, port } = await serve(2000);
    const slow = get(port, '/slow');
    await pause(100);
    const asked = Date.now();
    await server.shutdown();
    expect(Date.now() - asked).to.be.within(900, 3000);
    await slow.then(
      () => expect.fail('the held request was answered'),
      () => undefined
    );
  });
});

const child = path.join(__dirname, '..', 'fixtures', 'serverChild.ts');

/** Run the server fixture, sending `signal` once it says it is ready */
const runChild = (
  mode: string,
  signal?: NodeJS.Signals
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  lines: string[];
  ms: number;
}> =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let ready: number | undefined;
    const keep = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(line);
        if (line === 'ready') {
          ready = Date.now();
          if (signal) proc.kill(signal);
        }
      }
    };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.on('error', reject);
    proc.on('exit', (code, exitSignal) =>
      resolve({
        code,
        signal: exitSignal,
        lines,
        ms: ready === undefined ? -1 : Date.now() - ready,
      })
    );
  });

describe('Crash policy', function () {
  this.timeout(30000);

  it('shuts down and exits with 1 on an uncaught exception', async () => {
    const out = await runChild('crash');
    expect(out.code, out.lines.join('\n')).to.equal(1);
    expect(out.lines.some(l => /Uncaught exception: boom/.test(l))).to.equal(
      true
    );
    expect(
      out.lines.some(l => l === 'closed'),
      'the plugin let go'
    ).to.equal(true);
  });

  it('exits with 1 within the budget when a close never settles', async () => {
    const out = await runChild('crash-hangs');
    expect(out.code, out.lines.join('\n')).to.equal(1);
    expect(out.lines).to.include('closing');
    expect(out.ms).to.be.within(900, 6000);
  });
});

describe('Signal policy', function () {
  this.timeout(30000);

  it('shuts down on SIGTERM, then lets the signal end the process', async () => {
    const out = await runChild('signal', 'SIGTERM');
    expect(out.signal, out.lines.join('\n')).to.equal('SIGTERM');
    expect(out.lines).to.include('closed');
  });
});
