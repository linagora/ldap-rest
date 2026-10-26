import { expect } from 'chai';
import supertest from 'supertest';
import Transport from 'winston-transport';
import type { Express, Request, Response } from 'express';

import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';
import { changeContext, requestId } from '../../src/lib/changeContext';
import { launchHooks } from '../../src/lib/utils';
import { outsideRequest } from '../../src/lib/requestContext';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Keeps what the logger wrote, as the console transport would see it */
class Captured extends Transport {
  lines: Array<{ level: string; message: string; requestId?: string }> = [];
  log(info: Record<string, unknown>, next: () => void): void {
    this.lines.push({
      level: String(info.level),
      message: String(info.message),
      requestId: info.requestId as string | undefined,
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
      hooks = {
        probedone: (): void => {
          throw new Error('a hook failing');
        },
      };
      api(app: Express): void {
        app.get('/probe', async (req: Request, res: Response) => {
          this.logger.info('serving the probe');
          // As the server, the line is still the request's
          outsideRequest(() => this.logger.info('as the server'));
          await launchHooks(
            (server.hooks as Record<string, unknown[]>).probedone as never,
            []
          );
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
      /serving the probe|as the server|Hook error/.test(l.message)
    );
    expect(served.map(l => l.requestId)).to.deep.equal([id, id, id]);
  });

  it('gives each request its own id', async () => {
    const [a, b] = await Promise.all([
      request.get('/probe'),
      request.get('/probe'),
    ]);
    expect(a.headers['x-request-id']).not.to.equal(b.headers['x-request-id']);
  });

  it('writes no id outside a request', () => {
    captured.lines = [];
    server.logger.info('at rest');
    expect(captured.lines[0]).to.deep.equal({
      level: 'info',
      message: 'at rest',
      requestId: undefined,
    });
  });
});
