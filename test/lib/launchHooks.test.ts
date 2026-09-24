import { expect } from 'chai';
import type winston from 'winston';

import { launchHooks, recordHookOwner } from '../../src/lib/utils';
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
  let installed: winston.Logger | undefined;
  let reported: unknown[][] = [];
  const fakeLogger = {
    error: (...args: unknown[]) => {
      reported.push(args);
    },
  } as unknown as winston.Logger;

  before(() => {
    // Captured here rather than in the describe body: mocha evaluates every
    // spec file before running any suite, so a `const` written there holds
    // the logger of a moment when no `DM` existed — and restoring it in
    // `afterEach` would uninstall the one a suite running earlier had set.
    installed = getLogger();
  });

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

  it('names the hook and its plugin when registerPlugin recorded them', async () => {
    setLogger(fakeLogger);
    const boom = new Error('boom');
    const hook = (): never => {
      throw boom;
    };
    recordHookOwner(hook, 'james', 'ldapadddone');

    await launchHooks([hook]);

    expect(reported).to.have.lengthOf(1);
    expect(reported[0][0]).to.equal('Hook error in james (ldapadddone)');
    expect(reported[0][1]).to.equal(boom);
  });

  it("names a hook no plugin recorded by the function's own name", async () => {
    setLogger(fakeLogger);

    await launchHooks([
      function pushedByHand(): never {
        throw 'refused';
      },
    ]);

    expect(reported[0][0]).to.equal('Hook error in pushedByHand: "refused"');
  });

  it('reports a thrown value that is not an Error', async () => {
    // winston keeps a second argument only when it is an object, so a hook
    // throwing a string used to report `Hook error` and nothing more.
    setLogger(fakeLogger);

    await launchHooks([
      () => {
        throw 'a string thrown';
      },
    ]);

    expect(reported).to.have.lengthOf(1);
    expect(reported[0][0]).to.equal('Hook error: "a string thrown"');
  });

  it('reports a circular thrown value without throwing itself', async () => {
    // The reporter runs inside the catch that exists to swallow; a value it
    // cannot describe must not become the failure it was reporting.
    setLogger(fakeLogger);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await launchHooks([
      () => {
        throw circular;
      },
    ]);

    expect(reported).to.have.lengthOf(1);
    expect(reported[0][0]).to.equal('Hook error: [object Object]');
  });

  it('does not throw when no logger has been installed yet', async () => {
    // The app's order: this module is evaluated (through `ldapActions`)
    // before the `DM` constructor hands its logger to `setLogger`.
    setLogger(undefined);

    await launchHooks([
      () => {
        throw new Error('boom');
      },
    ]);
  });
});
