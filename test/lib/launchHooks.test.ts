import { expect } from 'chai';
import type winston from 'winston';

import { launchHooks } from '../../src/lib/utils';
import { getLogger, setLogger } from '../../src/lib/expressFormatedResponses';

/**
 * `launchHooks` reports and ignores: a hook that throws has to reach the log
 * and must not travel up to its caller.
 *
 * The report has to survive the app's own load order — `setLogger` runs in
 * the `DM` constructor, and this module is loaded before that through
 * `ldapActions` — so what these pin is that the logger is looked up when the
 * hook fails, not when the module was evaluated.
 */
describe('launchHooks', () => {
  const installed = getLogger();
  let reported: unknown[][] = [];
  const fakeLogger = {
    error: (...args: unknown[]) => {
      reported.push(args);
    },
  } as unknown as winston.Logger;

  beforeEach(() => {
    reported = [];
  });

  afterEach(() => {
    setLogger(installed);
  });

  it('reports a hook that throws, and does not reject', async () => {
    setLogger(fakeLogger);
    const boom = new Error('boom');

    await launchHooks([
      () => {
        throw boom;
      },
    ]);

    expect(reported).to.have.lengthOf(1);
    expect(reported[0][0]).to.equal('Hook error');
    expect(reported[0][1]).to.equal(boom);
  });

  it('runs the hooks that follow a failing one', async () => {
    setLogger(fakeLogger);
    const ran: string[] = [];

    await launchHooks([
      () => {
        throw new Error('boom');
      },
      () => {
        ran.push('second');
      },
    ]);

    expect(ran).to.deep.equal(['second']);
  });

  it('does not throw when no logger has been installed yet', async () => {
    // The app's order: this module is evaluated (through `ldapActions`)
    // before the `DM` constructor hands its logger to `setLogger`.
    setLogger(undefined as unknown as winston.Logger);

    await launchHooks([
      () => {
        throw new Error('boom');
      },
    ]);
  });
});
