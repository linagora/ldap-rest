import { Agent, request as httpRequest } from 'http';
import type { AddressInfo } from 'net';

import { expect } from 'chai';
import supertest from 'supertest';
import express from 'express';
import type { Response } from 'express';

import {
  allowedMethods,
  installApiFallback,
  pathOf,
  underPrefix,
} from '../../src/lib/apiFallback';
import { NotFoundError } from '../../src/lib/errors';
import { DM } from '../../src/bin';
import type { Role } from '../../src/abstract/plugin';
import AuthBase, { type DmRequest } from '../../src/lib/auth/base';
import { LDAP_ENV_VARS, skipIfMissingEnvVars } from '../helpers/env';

const build = (prefix = '/api'): express.Express => {
  const app = express();
  installApiFallback(
    app,
    () => prefix,
    () => false
  );
  app.get('/api/things', (_req, res) => {
    res.json(['thing']);
  });
  app.post('/api/things', (_req, res) => {
    res.status(201).json({});
  });
  app.delete('/api/things/:id', (_req, res) => {
    res.json({ deleted: true });
  });
  return app;
};

describe('API fallback', () => {
  it('answers a JSON 404 for a path no route serves under the prefix', async () => {
    const res = await supertest(build()).get('/api/nothing');
    expect(res.status).to.equal(404);
    expect(res.type).to.equal('application/json');
    expect(res.body).to.deep.equal({ error: 'Not found' });
  });

  it('answers the prefix itself too', async () => {
    const res = await supertest(build()).get('/api');
    expect(res.status).to.equal(404);
    expect(res.type).to.equal('application/json');
  });

  it('answers 405 naming the methods the path takes', async () => {
    const app = build();
    const res = await supertest(app).put('/api/things');
    expect(res.status).to.equal(405);
    expect(res.headers.allow).to.equal('GET, HEAD, POST');
    expect(res.type).to.equal('application/json');
    expect(res.body).to.deep.equal({ error: 'Method Not Allowed' });

    const one = await supertest(app).get('/api/things/42');
    expect(one.status).to.equal(405);
    expect(one.headers.allow).to.equal('DELETE');
  });

  it('ignores the query when matching the path', async () => {
    const res = await supertest(build()).put('/api/things?x=1');
    expect(res.status).to.equal(405);
  });

  it('leaves the routes served as they were', async () => {
    const app = build();
    expect((await supertest(app).get('/api/things')).body).to.deep.equal([
      'thing',
    ]);
    expect((await supertest(app).head('/api/things')).status).to.equal(200);
  });

  it('leaves OPTIONS to Express, which lists the methods', async () => {
    const res = await supertest(build()).options('/api/things');
    expect(res.status).to.equal(200);
    expect(res.headers.allow).to.equal('GET, HEAD, POST');
  });

  it('keeps reachable a route registered after it', async () => {
    // What a catch-all middleware broke: a host or test adding a route
    // once the server is set up
    const app = build();
    app.put('/api/late', (_req, res) => {
      res.json({ late: true });
    });
    const res = await supertest(app).put('/api/late');
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ late: true });
  });

  it("leaves Express's answer outside the prefix", async () => {
    const res = await supertest(build()).put('/elsewhere');
    expect(res.status).to.equal(404);
    expect(res.type).to.equal('text/html');
  });

  it('does not take the paths that only start like the prefix', async () => {
    const res = await supertest(build()).get('/apiary');
    expect(res.type).to.equal('text/html');
  });

  it('answers JSON for an error nothing handled', async () => {
    const app = build();
    app.get('/api/broken', () => {
      throw new NotFoundError('No such thing');
    });
    const res = await supertest(app).get('/api/broken');
    expect(res.status).to.equal(404);
    expect(res.body).to.deep.equal({ error: 'No such thing' });
  });

  it('hands the request back to a host that mounts the app', async () => {
    const host = express();
    host.use(build());
    host.use((_req, res) => {
      res.status(418).json({ host: true });
    });
    const res = await supertest(host).get('/api/nothing');
    expect(res.status).to.equal(418);
    expect(res.body).to.deep.equal({ host: true });
  });

  it('reads the prefix at each request', async () => {
    let prefix = '/api';
    const app = express();
    installApiFallback(
      app,
      () => prefix,
      () => false
    );
    expect((await supertest(app).get('/v2/x')).type).to.equal('text/html');
    prefix = '/v2';
    expect((await supertest(app).get('/v2/x')).type).to.equal(
      'application/json'
    );
  });

  describe('underPrefix', () => {
    it('ignores case unless the routing is case sensitive', () => {
      expect(underPrefix('/API/x', '/api')).to.be.true;
      expect(underPrefix('/API/x', '/api', true)).to.be.false;
    });

    it('takes the prefix and what is under it, nothing else', () => {
      expect(underPrefix('/api', '/api')).to.be.true;
      expect(underPrefix('/api/x', '/api')).to.be.true;
      expect(underPrefix('/apix', '/api')).to.be.false;
      expect(underPrefix('/x', '')).to.be.true;
      expect(underPrefix('/x', '/')).to.be.true;
    });
  });

  describe('allowedMethods', () => {
    it('lists nothing for a path no route matches', () => {
      expect(allowedMethods(build(), '/api/none')).to.deep.equal([]);
    });

    it('lists nothing, rather than failing, when the internals move', () => {
      const moved = (router: unknown): express.Express =>
        ({ router }) as unknown as express.Express;
      expect(allowedMethods(moved(undefined), '/api/x')).to.deep.equal([]);
      expect(allowedMethods(moved({ stack: 'x' }), '/api/x')).to.deep.equal([]);
      expect(
        allowedMethods(
          moved({ stack: [{ route: {}, matchers: [() => true] }] }),
          '/api/x'
        )
      ).to.deep.equal([]);
      expect(
        allowedMethods(
          moved({
            stack: [
              {
                route: { _methods: () => ['GET'] },
                matchers: [
                  () => {
                    throw new Error('moved');
                  },
                ],
              },
            ],
          }),
          '/api/x'
        )
      ).to.deep.equal([]);
    });
  });

  it('ignores case in the prefix, as the routing does', async () => {
    const app = build();
    expect((await supertest(app).get('/API/things')).status).to.equal(200);
    const res = await supertest(app).put('/API/things');
    expect(res.status).to.equal(405);
    expect(res.type).to.equal('application/json');
  });

  it('reads the path of an absolute-form request target', async () => {
    // What a proxy may send: the router routes it by its path
    const server = build().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const { status, type } = await new Promise<{
        status?: number;
        type?: string;
      }>((resolve, reject) => {
        httpRequest(
          {
            port,
            method: 'PUT',
            path: `http://localhost:${port}/api/things`,
          },
          res => {
            res.resume();
            resolve({
              status: res.statusCode,
              type: res.headers['content-type'],
            });
          }
        )
          .on('error', reject)
          .end();
      });
      expect(status).to.equal(405);
      expect(type).to.match(/^application\/json/);
    } finally {
      server.close();
    }
  });

  it('answers JSON for a parameter the router cannot decode', async () => {
    const res = await supertest(build()).delete('/api/things/%E0%A4%A');
    expect(res.status).to.equal(400);
    expect(res.type).to.equal('application/json');
    expect(res.body.error).to.match(/Failed to decode param/);
  });

  it('answers a failure nothing handled as the error middleware does', async () => {
    const app = build();
    app.get('/api/crash', () => {
      throw new Error('disk on fire');
    });
    const res = await supertest(app).get('/api/crash');
    expect(res.status).to.equal(500);
    expect(res.body).to.deep.equal({
      error: 'Internal Server Error',
      message: 'An error occurred',
    });
  });

  it('names that failure under --debug', async () => {
    const app = express();
    installApiFallback(
      app,
      () => '/api',
      () => true
    );
    app.get('/api/crash', () => {
      throw new Error('disk on fire');
    });
    const res = await supertest(app).get('/api/crash');
    expect(res.status).to.equal(500);
    expect(res.body.message).to.match(/disk on fire/);
  });

  it('leaves the connection of a handler that answered, then called next', async () => {
    // finalhandler leaves an ended response alone: destroying the socket
    // would drop a keep-alive connection after a complete answer
    const app = build();
    const sockets: unknown[] = [];
    app.get('/api/twice', (req, res, next) => {
      sockets.push(req.socket);
      res.json({ once: true });
      next();
    });
    const server = app.listen(0);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const { port } = server.address() as AddressInfo;
      const get = (): Promise<string> =>
        new Promise((resolve, reject) => {
          httpRequest({ port, agent, path: '/api/twice' }, res => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => resolve(body));
          })
            .on('error', reject)
            .end();
        });
      expect(JSON.parse(await get())).to.deep.equal({ once: true });
      expect(JSON.parse(await get())).to.deep.equal({ once: true });
      expect(sockets).to.have.lengthOf(2);
      expect(sockets[1], 'the same connection, kept').to.equal(sockets[0]);
    } finally {
      agent.destroy();
      server.close();
    }
  });

  it('cuts an answer begun and abandoned', async () => {
    const app = build();
    app.get('/api/half', (_req, res, next) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"half":');
      next();
    });
    const failed = await supertest(app)
      .get('/api/half')
      .then(
        () => false,
        () => true
      );
    expect(failed).to.equal(true);
  });

  it('sees only the routes on the app, not a mounted router', async () => {
    // The documented limit: a mounted router's paths get a 404, not a 405
    const app = build();
    const router = express.Router();
    router.get('/mounted', (_req, res) => {
      res.json({});
    });
    app.use('/api', router);
    expect((await supertest(app).get('/api/mounted')).status).to.equal(200);
    const res = await supertest(app).put('/api/mounted');
    expect(res.status).to.equal(404);
    expect(res.type).to.equal('application/json');
  });

  describe('pathOf', () => {
    it('drops the query and reads an absolute-form target', () => {
      expect(pathOf('/api/x?y=1')).to.equal('/api/x');
      expect(pathOf('http://host:8080/api/x?y=1')).to.equal('/api/x');
      expect(pathOf('*')).to.equal('*');
    });
  });

  describe('on the server', function () {
    let server: DM;

    before(function () {
      skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
      server = new DM();
      server.app.get('/api/v1/known', (_req, res) => {
        res.json({ known: true });
      });
      server.setupErrorMiddleware();
    });

    it('answers JSON under --api-prefix', async () => {
      const missing = await supertest(server.app).get('/api/v1/nope');
      expect(missing.status).to.equal(404);
      expect(missing.type).to.equal('application/json');
      const wrong = await supertest(server.app).put('/api/v1/known');
      expect(wrong.status).to.equal(405);
      expect(wrong.headers.allow).to.equal('GET, HEAD');
    });

    it('lets authentication answer first', async () => {
      // An anonymous caller is not told which paths exist
      class Refusing extends AuthBase {
        name = 'refusing';
        roles: Role[] = ['auth'];
        authMethod(_req: DmRequest, res: Response): void {
          res.status(401).json({ error: 'Unauthorized' });
        }
      }
      await server.registerPlugin('refusing', new Refusing(server));
      try {
        expect(
          (await supertest(server.app).get('/api/v1/nope')).status
        ).to.equal(401);
        expect(
          (await supertest(server.app).put('/api/v1/known')).status
        ).to.equal(401);
      } finally {
        delete server.loadedPlugins.refusing;
      }
    });
  });
});
