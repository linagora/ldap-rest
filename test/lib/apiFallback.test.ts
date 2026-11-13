import { expect } from 'chai';
import supertest from 'supertest';
import express from 'express';
import type { Response } from 'express';

import {
  allowedMethods,
  installApiFallback,
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
