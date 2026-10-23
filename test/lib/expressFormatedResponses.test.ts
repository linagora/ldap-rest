import { expect } from 'chai';
import express, { type Response } from 'express';
import bodyParser from 'body-parser';
import supertest from 'supertest';
import type winston from 'winston';

import { AUTHZ_REFUSED, ConflictError } from '../../src/lib/errors';
import {
  getLogger,
  jsonBody,
  serverError,
  setLogger,
} from '../../src/lib/expressFormatedResponses';

/**
 * `serverError` answers the request whatever it logs: a missing logger —
 * nothing called `setLogger`, because no `DM` was built — must cost the log
 * line, not the response.
 */
describe('serverError', () => {
  let installed: winston.Logger | undefined;

  /** A response that records what was sent. */
  const fakeResponse = (): {
    res: Response;
    sent: { status?: number; body?: unknown };
  } => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    } as unknown as Response;
    return { res, sent };
  };

  before(() => {
    // Captured when the suite starts, not when the file is evaluated: mocha
    // loads every spec before running any, and restoring a value captured
    // then would uninstall the logger a suite running earlier had set.
    installed = getLogger();
  });

  beforeEach(() => {
    setLogger(undefined);
  });

  afterEach(() => {
    setLogger(installed);
  });

  it('answers 500 without a logger', () => {
    const { res, sent } = fakeResponse();

    serverError(res, new Error('the directory is down'));

    expect(sent).to.deep.equal({ status: 500, body: { error: 'check logs' } });
  });

  it('answers 500 without a logger when the thrown value is not an Error', () => {
    const { res, sent } = fakeResponse();

    serverError(res, 'a string thrown');
    expect(sent.status).to.equal(500);

    const other = fakeResponse();
    serverError(other.res, { code: 42 });
    expect(other.sent.status).to.equal(500);
  });

  it('answers a client error without a logger', () => {
    const { res, sent } = fakeResponse();
    const err = Object.assign(new Error('no such entry'), { statusCode: 404 });

    serverError(res, err);

    expect(sent).to.deep.equal({
      status: 404,
      body: { error: 'no such entry' },
    });
  });

  it('adds the refusal a client error carries to its sentence', () => {
    const { res, sent } = fakeResponse();

    serverError(
      res,
      new ConflictError('user: "a@example.com" is already used', {
        code: 'unique',
        attribute: 'mail',
        value: 'a@example.com',
      })
    );

    expect(sent).to.deep.equal({
      status: 409,
      body: {
        error: 'user: "a@example.com" is already used',
        code: 'unique',
        attribute: 'mail',
        value: 'a@example.com',
      },
    });
  });

  it('codes an authorization refusal without naming its branch', () => {
    const { res, sent } = fakeResponse();

    // Wrapped into a plain Error: only the marker is left
    serverError(
      res,
      new Error('[authz-forbidden] User bob may not write ou=Sales,dc=x')
    );

    expect(sent).to.deep.equal({
      status: 403,
      body: { error: AUTHZ_REFUSED, code: 'forbidden' },
    });
  });
});

/**
 * Callers return as soon as `jsonBody` gives `false` or nothing, taking it as
 * "already answered": a body it hands back undefined leaves the request open.
 */
describe('jsonBody', () => {
  const app = express();
  app.use(bodyParser.json());
  app.post('/none', (req, res) => {
    const body = jsonBody(req, res);
    if (!body) return;
    res.json({ got: body });
  });
  app.post('/required', (req, res) => {
    const body = jsonBody(req, res, 'name');
    if (!body) return;
    res.json({ got: body });
  });
  const request = supertest(app);

  for (const path of ['/none', '/required']) {
    it(`answers 400 to a text body (${path})`, async () => {
      const res = await request
        .post(path)
        .timeout(2000)
        .type('text/plain')
        .send('hello');
      expect(res.status).to.equal(400);
      expect(res.body).to.deep.equal({ error: 'Bad content' });
    });

    it(`answers 400 to a request without a body (${path})`, async () => {
      const res = await request.post(path).timeout(2000);
      expect(res.status).to.equal(400);
    });

    it(`answers 400 to a JSON array (${path})`, async () => {
      const res = await request.post(path).timeout(2000).send([1, 2]);
      expect(res.status).to.equal(400);
    });
  }

  it('hands back a JSON object without required fields', async () => {
    const res = await request.post('/none').timeout(2000).send({});
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ got: {} });
  });

  it('hands back a JSON object carrying the required fields', async () => {
    const res = await request
      .post('/required')
      .timeout(2000)
      .send({ name: 'x' });
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ got: { name: 'x' } });
  });
});
