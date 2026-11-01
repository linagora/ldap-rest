import { createServer, connect, type AddressInfo } from 'node:net';

import { expect } from 'chai';
import supertest from 'supertest';
import Transport from 'winston-transport';
import type { Express, Request, Response } from 'express';
import type { SearchOptions } from 'ldapts';

import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';
import WebLogs from '../../src/plugins/weblogs';
import PostgresStore from '../../src/plugins/storage/postgres';
import ValkeyStore from '../../src/plugins/storage/valkey';
import { changeContext, requestId } from '../../src/lib/changeContext';
import HookBus from '../../src/lib/hookBus';
import type { Hooks } from '../../src/hooks';
import {
  currentLogContext,
  outsideAnyRequest,
  outsideRequest,
  runWithLogContext,
} from '../../src/lib/requestContext';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Keeps what the logger wrote, as the console transport would see it */
class Captured extends Transport {
  lines: Array<{
    level: string;
    message: string;
    requestId?: string;
    plugin?: string;
    op?: string;
  }> = [];
  log(info: Record<string, unknown>, next: () => void): void {
    this.lines.push({
      level: String(info.level),
      message: String(info.message),
      requestId: info.requestId as string | undefined,
      plugin: info.plugin as string | undefined,
      op: info.op as string | undefined,
    });
    next();
  }
}

describe('Request id', () => {
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let captured: Captured;

  before(async () => {
    server = new DM();
    await server.ready;
    captured = new Captured();
    server.logger.add(captured);
    // The lines under test are informational
    server.logger.level = 'info';
    class Probe extends DmPlugin {
      name = 'probe';
      // Two hooks the server declares, so `registerPlugin` records the
      // plugin they belong to: that is what names them on the lines they
      // write.
      hooks: Hooks = {
        ldapadddone: async (): Promise<void> => {
          this.logger.info('in the hook');
          this.logger.info({ message: 'as another plugin', plugin: 'other' });
          this.logger.info({ message: 'as itself', plugin: 'probe' });
          this.logger.info({ message: 'on its own op', op: 'mine' });
          await new HookBus({
            ldapadddone: [
              function unregistered(): void {
                server.logger.info('in a hook no plugin registered');
              },
            ],
          }).notifyAndWait('ldapadddone', 'cn=x', {}, {});
          throw new Error('a hook failing');
        },
        ldapsearchopts: (opts: SearchOptions): SearchOptions => {
          this.logger.info('in the chained hook');
          return opts;
        },
      };
      api(app: Express): void {
        app.get('/probe', async (req: Request, res: Response) => {
          this.logger.info(
            `serving the probe${req.query.who ? ` for ${String(req.query.who)}` : ''}`
          );
          // As the server, the line is still the request's
          outsideRequest(() => this.logger.info('as the server'));
          await server.hookBus.notifyAndWait('ldapadddone', 'cn=x', {}, {});
          await server.hookBus.chain('ldapsearchopts', { paged: false });
          res.json({
            id: requestId(req),
            context: changeContext(req).requestId,
          });
        });
      }
    }
    await server.registerPlugin('probe', new Probe(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);
  });

  after(() => {
    server.logger.remove(captured);
  });

  it('answers with the id its writes and its log lines carry', async () => {
    captured.lines = [];
    const res = await request.get('/probe').set('X-Request-Id', 'forged');
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    const id = res.headers['x-request-id'];
    expect(id).to.match(UUID);
    expect(id, 'not the header sent').not.to.equal('forged');
    expect(res.body).to.deep.equal({ id, context: id });
    const served = captured.lines.filter(l =>
      /serving the probe|as the server|in the hook|as another|Hook error/.test(
        l.message
      )
    );
    expect(served.map(l => l.requestId)).to.deep.equal([id, id, id, id, id]);
  });

  it('names the plugin and the hook on the lines a hook writes', async () => {
    captured.lines = [];
    await request.get('/probe').expect(200);
    const fields = (start: string): [string?, string?] => {
      const line = captured.lines.find(l => l.message.startsWith(start));
      expect(line, start).to.not.equal(undefined);
      return [line!.plugin, line!.op];
    };
    expect(fields('serving the probe')).to.deep.equal([undefined, undefined]);
    expect(fields('in the hook')).to.deep.equal(['probe', 'ldapadddone']);
    expect(fields('in the chained hook')).to.deep.equal([
      'probe',
      'ldapsearchopts',
    ]);
    expect(fields('Hook error')).to.deep.equal(['probe', 'ldapadddone']);
    expect(fields('as itself')).to.deep.equal(['probe', 'ldapadddone']);
    expect(fields('on its own op')).to.deep.equal(['probe', 'mine']);
    expect(fields('as another plugin'), 'its own name kept').to.deep.equal([
      'other',
      undefined,
    ]);
    expect(
      fields('in a hook no plugin registered'),
      'not the hook it was launched from'
    ).to.deep.equal([undefined, undefined]);
  });

  it('gives each request its own id, on its own lines', async () => {
    captured.lines = [];
    const [a, b] = await Promise.all([
      request.get('/probe?who=a'),
      request.get('/probe?who=b'),
    ]);
    const ids = [a, b].map(r => r.headers['x-request-id'] as string);
    expect(ids[0]).not.to.equal(ids[1]);
    const line = (who: string): string | undefined =>
      captured.lines.find(l => l.message === `serving the probe for ${who}`)
        ?.requestId;
    expect([line('a'), line('b')]).to.deep.equal(ids);
  });

  it('names the weblogs line of a response closed before its end', () => {
    captured.lines = [];
    const req = {
      method: 'GET',
      originalUrl: '/gone',
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request;
    const weblogs = new WebLogs(server);
    // From the socket, outside any context
    weblogs.log(req, { statusCode: 499 } as Response, Date.now(), {
      error: 'Connection closed before response was sent',
    });
    expect(captured.lines[0].requestId).to.equal(requestId(req));
  });

  describe('a connection the server keeps', () => {
    type Handlers = Record<string, (arg?: unknown) => void>;

    it('reports a lost PostgreSQL connection under no request', async () => {
      const handlers: Handlers = {};
      class Stubbed extends PostgresStore {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        protected async driver(): Promise<any> {
          return {
            Pool: class {
              on(event: string, handler: (arg?: unknown) => void): void {
                handlers[event] = handler;
              }
              async query(): Promise<unknown> {
                return { rows: [{ t: 'records' }] };
              }
              async end(): Promise<void> {}
            },
          };
        }
      }
      const store = new Stubbed(server.logger, 'postgres://ctx', 'records');
      await runWithLogContext({ requestId: 'A' }, () => store.open());
      captured.lines = [];
      runWithLogContext({ requestId: 'B' }, () =>
        handlers.error(new Error('idle connection dropped'))
      );
      expect(captured.lines[0].message).to.match(/connection lost/);
      expect(captured.lines[0].requestId).to.equal(undefined);
    });

    it('reports a Valkey connection lost and back under no request', async () => {
      const handlers: Handlers = {};
      class Stubbed extends ValkeyStore {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        protected async driver(): Promise<any> {
          return {
            Valkey: class {
              on(event: string, handler: (arg?: unknown) => void): this {
                handlers[event] = handler;
                return this;
              }
              async connect(): Promise<void> {}
              async quit(): Promise<void> {}
              disconnect(): void {}
            },
          };
        }
      }
      const store = new Stubbed(server.logger, 'valkey://ctx', '');
      await runWithLogContext({ requestId: 'A' }, () => store.open());
      captured.lines = [];
      runWithLogContext({ requestId: 'B' }, () => {
        handlers.error(new Error('read ECONNRESET'));
        handlers.ready();
      });
      expect(captured.lines.map(l => l.message)).to.deep.equal([
        'storage/valkey: connection lost: read ECONNRESET',
        'storage/valkey: connection back',
      ]);
      expect(captured.lines.map(l => l.requestId)).to.deep.equal([
        undefined,
        undefined,
      ]);
    });
  });

  it('names a body a parser refused', async () => {
    captured.lines = [];
    const res = await request.post('/probe').type('json').send('{"not": json');
    expect(res.status).to.equal(400);
    const id = res.headers['x-request-id'];
    expect(id).to.match(UUID);
    const refusal = captured.lines.find(l => /400/.test(l.message));
    expect(refusal?.requestId, JSON.stringify(captured.lines)).to.equal(id);
  });

  it('leaves no id to a connection opened for the process', async () => {
    const listener = createServer(socket => socket.end('hello'));
    await new Promise<void>(resolve =>
      listener.listen(0, '127.0.0.1', resolve)
    );
    const { port } = listener.address() as AddressInfo;
    try {
      const seen = await runWithLogContext({ requestId: 'A' }, () =>
        outsideAnyRequest(
          () =>
            new Promise<string | undefined>(resolve => {
              const socket = connect(port, '127.0.0.1');
              socket.on('data', () => resolve(currentLogContext()?.requestId));
            })
        )
      );
      expect(seen).to.equal(undefined);
      const kept = await runWithLogContext({ requestId: 'A' }, () =>
        outsideRequest(() => currentLogContext()?.requestId)
      );
      expect(kept, 'as the server, still the request').to.equal('A');
    } finally {
      listener.close();
    }
  });

  it('writes no id outside a request', () => {
    captured.lines = [];
    server.logger.info('at rest');
    expect(captured.lines[0]).to.deep.equal({
      level: 'info',
      message: 'at rest',
      requestId: undefined,
      plugin: undefined,
      op: undefined,
    });
  });
});
