import { expect } from 'chai';
import bodyParser from 'body-parser';
import express, { type Express } from 'express';
import supertest from 'supertest';
import { Type } from '@sinclair/typebox';

import { BadRequestError } from '../../src/lib/errors';
import { errorResponse } from '../../src/lib/expressFormatedResponses';
import {
  defineRoute,
  registeredRoutes,
  unregisteredRoutes,
} from '../../src/lib/route';

const appWith = (): Express => {
  const app = express();
  app.use(bodyParser.json());
  return app;
};

/** The error middleware answers last, as on the server. */
const serveErrors = (app: Express): Express => {
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const { status, body } = errorResponse(err);
      res.status(status).json(body);
    }
  );
  return app;
};

describe('defineRoute', () => {
  it('hands the handler the checked and converted values', async () => {
    const app = appWith();
    let received: unknown;
    defineRoute(app, {
      method: 'post',
      path: '/things/:cn',
      params: Type.Object({ cn: Type.String({ minLength: 1 }) }),
      query: Type.Object({ limit: Type.Number() }),
      body: Type.Object({ member: Type.String() }),
      handler: ({ params, query, body, res }) => {
        received = { params, query, body };
        res.status(204).send();
      },
    });
    serveErrors(app);

    await supertest(app)
      .post('/things/team?limit=10')
      .send({ member: 'uid=one' })
      .expect(204);

    expect(received).to.deep.equal({
      params: { cn: 'team' },
      query: { limit: 10 },
      body: { member: 'uid=one' },
    });
  });

  it('refuses an unexpected body key, naming its path', async () => {
    const app = appWith();
    let called = false;
    defineRoute(app, {
      method: 'post',
      path: '/things',
      body: Type.Object(
        { member: Type.String() },
        { additionalProperties: false }
      ),
      handler: ({ res }) => {
        called = true;
        res.status(204).send();
      },
    });
    serveErrors(app);

    const res = await supertest(app)
      .post('/things')
      .send({ member: 'uid=one', role: 'admin' })
      .expect(400);

    expect(res.body.error).to.equal(
      'Invalid request: body.role: Unexpected property'
    );
    expect(called).to.equal(false);
  });

  it('names the whole body when it is not an object', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'post',
      path: '/things',
      body: Type.Object({ member: Type.String() }),
      handler: ({ res }) => {
        res.sendStatus(204);
      },
    });
    serveErrors(app);

    const array = await supertest(app).post('/things').send([1]).expect(400);
    expect(array.body.error).to.equal('Invalid request: body: Expected object');

    const missing = await supertest(app).post('/things').expect(400);
    expect(missing.body.error).to.equal(
      'Invalid request: body.member: Expected required property; body.member: Expected string'
    );
  });

  it('treats an absent body as no fields', async () => {
    const app = appWith();
    let received: unknown;
    defineRoute(app, {
      method: 'post',
      path: '/things',
      body: Type.Object({ name: Type.Optional(Type.String()) }),
      handler: ({ body, res }) => {
        received = body;
        res.sendStatus(204);
      },
    });
    serveErrors(app);

    await supertest(app).post('/things').expect(204);
    expect(received).to.deep.equal({});
  });

  it('refuses a caller that does not accept JSON, before the handler', async () => {
    const app = appWith();
    let called = false;
    defineRoute(app, {
      method: 'get',
      path: '/things',
      handler: ({ res }) => {
        called = true;
        res.sendStatus(200);
      },
    });
    serveErrors(app);

    const res = await supertest(app)
      .get('/things')
      .set('Accept', 'text/html')
      .expect(400);
    expect(res.body.error).to.equal('Bad request');
    expect(called).to.equal(false);
  });

  it('reads an integer query only from its integer spelling', async () => {
    const app = appWith();
    let received: unknown;
    defineRoute(app, {
      method: 'get',
      path: '/things',
      query: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      handler: ({ query, res }) => {
        received = query;
        res.sendStatus(200);
      },
    });
    serveErrors(app);

    await supertest(app).get('/things?limit=10').expect(200);
    expect(received).to.deep.equal({ limit: 10 });

    for (const limit of ['1.5', '1e3', 'true', 'ten', '']) {
      const res = await supertest(app)
        .get('/things')
        .query({ limit })
        .expect(400);
      expect(res.body.error, `limit=${limit}`).to.equal(
        'Invalid request: query.limit: Expected integer'
      );
    }

    const zero = await supertest(app).get('/things?limit=0').expect(400);
    expect(zero.body.error).to.equal(
      'Invalid request: query.limit: Expected integer to be greater or equal to 1'
    );
  });

  it('answers a route of another media type under its own Accept', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/scim',
      json: false,
      handler: ({ res }) => {
        res.status(200).json({ ok: true });
      },
    });
    defineRoute(app, {
      method: 'get',
      path: '/json',
      handler: ({ res }) => {
        res.status(200).json({ ok: true });
      },
    });
    serveErrors(app);

    await supertest(app)
      .get('/scim')
      .set('Accept', 'application/scim+json')
      .expect(200);
    await supertest(app)
      .get('/json')
      .set('Accept', 'application/scim+json')
      .expect(400);
  });

  it('continues to the next route when the handler calls next', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/fallthrough',
      json: false,
      handler: ({ next }) => next(),
    });
    app.get('/fallthrough', (_req, res) => {
      res.status(200).json({ next: true });
    });
    serveErrors(app);

    const res = await supertest(app).get('/fallthrough').expect(200);
    expect(res.body).to.deep.equal({ next: true });
  });

  it('hands the handler Express next, whose error reaches the middleware', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/next',
      handler: ({ next }) => next(new Error('boom')),
    });
    serveErrors(app);

    const res = await supertest(app).get('/next').expect(500);
    expect(res.body.error).to.equal('Internal Server Error');
  });

  it('names every failing part at once', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/things/:cn',
      params: Type.Object({ cn: Type.String({ minLength: 1 }) }),
      query: Type.Object({ limit: Type.Number() }),
      handler: ({ res }) => {
        res.sendStatus(200);
      },
    });
    serveErrors(app);

    const res = await supertest(app).get('/things/team?limit=none').expect(400);

    expect(res.body.error).to.equal(
      'Invalid request: query.limit: Expected number'
    );
  });

  it('lists the path parameter with the others', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'post',
      path: '/things/:cn',
      params: Type.Object({ cn: Type.String({ minLength: 3 }) }),
      body: Type.Object({ member: Type.String() }),
      handler: ({ res }) => {
        res.sendStatus(204);
      },
    });
    serveErrors(app);

    const res = await supertest(app)
      .post('/things/a')
      .send({ member: 42 })
      .expect(400);

    expect(res.body.error).to.equal(
      'Invalid request: params.cn: Expected string length greater or equal to 3; body.member: Expected string'
    );
  });

  it('leaves a part the route did not declare unchecked', async () => {
    const app = appWith();
    let received: unknown;
    defineRoute(app, {
      method: 'post',
      path: '/things',
      handler: ({ body, res }) => {
        received = body;
        res.status(204).send();
      },
    });
    serveErrors(app);

    await supertest(app)
      .post('/things?unexpected=yes')
      .send({ anything: true })
      .expect(204);

    expect(received).to.deep.equal({ anything: true });
  });

  it('accepts an undeclared query key unless the schema forbids it', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/things',
      query: Type.Object({ limit: Type.Number() }),
      handler: ({ res }) => {
        res.sendStatus(200);
      },
    });
    serveErrors(app);

    await supertest(app).get('/things?limit=2&other=x').expect(200);
  });

  it('records the route and its schemas, without the handler', () => {
    const app = appWith();
    const body = Type.Object({ member: Type.String() });
    defineRoute(app, {
      method: 'put',
      path: '/things/:cn',
      body,
      summary: 'Change a thing',
      tags: ['Things'],
      handler: ({ res }) => {
        res.sendStatus(204);
      },
    });

    const routes = registeredRoutes(app);
    expect(routes).to.have.length(1);
    expect(routes[0]).to.include({
      method: 'put',
      path: '/things/:cn',
      summary: 'Change a thing',
    });
    expect(routes[0].body).to.equal(body);
    expect(routes[0]).to.not.have.property('handler');
  });

  it('records nothing on another app', () => {
    const one = appWith();
    const other = appWith();
    defineRoute(one, {
      method: 'get',
      path: '/things',
      handler: ({ res }) => {
        res.sendStatus(200);
      },
    });

    expect(registeredRoutes(one)).to.have.length(1);
    expect(registeredRoutes(other)).to.be.empty;
  });

  it('names the routes declared outside defineRoute', () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/declared',
      handler: ({ res }) => {
        res.sendStatus(200);
      },
    });
    app.get('/raw', (_req, res) => {
      res.sendStatus(200);
    });
    app.post('/raw', (_req, res) => {
      res.sendStatus(200);
    });

    expect(unregisteredRoutes(app)).to.deep.equal([
      { method: 'GET', path: '/raw' },
      { method: 'POST', path: '/raw' },
    ]);
  });

  it('walks a mounted router', () => {
    const app = appWith();
    const router = express.Router();
    router.get('/nested', (_req, res) => {
      res.sendStatus(200);
    });
    app.use('/mount', router);

    expect(unregisteredRoutes(app)).to.deep.equal([
      { method: 'GET', path: '/nested' },
    ]);
  });

  it('answers a handler’s rejection as any other error', async () => {
    const app = appWith();
    defineRoute(app, {
      method: 'get',
      path: '/things',
      handler: () => {
        throw new BadRequestError('nope');
      },
    });
    serveErrors(app);

    const res = await supertest(app).get('/things').expect(400);
    expect(res.body).to.deep.equal({ error: 'nope' });
  });
});
