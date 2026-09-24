import { expect } from 'chai';
import type { Response } from 'express';
import type winston from 'winston';

import {
  getLogger,
  serverError,
  setLogger,
} from '../../src/lib/expressFormatedResponses';

/**
 * `serverError` answers the request whatever it logs: a missing logger —
 * nothing called `setLogger`, because no `DM` was built — must cost the log
 * line, not the response.
 */
describe('serverError', () => {
  let installed: winston.Logger;

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
    setLogger(undefined as unknown as winston.Logger);
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
});
