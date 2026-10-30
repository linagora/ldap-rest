import { expect } from 'chai';
import type { SearchOptions } from 'ldapts';
import type winston from 'winston';

import HookBus, { recordHookOwner } from '../../src/lib/hookBus';
import { getLogger, setLogger } from '../../src/lib/expressFormatedResponses';

/**
 * What the bus promises each kind of hook: a notification reports and
 * ignores, and can be waited for; a chain threads a value and lets a failure
 * through.
 *
 * The report has to survive the app's own load order — `setLogger` runs in
 * the `DM` constructor, and this module is loaded before that through
 * `ldapActions` — so what these pin is that the logger is looked up when the
 * hook fails, not when the module was evaluated.
 */
describe('HookBus', () => {
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

  describe('chain', () => {
    it('threads what each hook answers into the next', async () => {
      const bus = new HookBus({
        ldapsearchopts: [
          (opts: SearchOptions) => {
            void opts;
            return { paged: false };
          },
        ],
      });

      const value = await bus.chain('ldapsearchopts', { paged: true });

      expect(value).to.deep.equal({ paged: false });
    });

    it('lets a refusal travel up, and names its plugin', async () => {
      setLogger(fakeLogger);
      const bus = new HookBus({
        ldapaddrequest: [
          () => {
            throw new Error('[authz-forbidden] not yours');
          },
        ],
      });
      const warned: string[] = [];
      setLogger({
        warn: (message: string) => warned.push(String(message)),
      } as unknown as winston.Logger);

      let refused = false;
      await bus.chain('ldapaddrequest', ['cn=x', {}, undefined]).catch(() => {
        refused = true;
      });

      expect(refused).to.equal(true);
      expect(warned).to.deep.equal([
        'a hook no plugin registered (anonymous) refused: [authz-forbidden] not yours',
      ]);
    });

    it('answers the value when nothing subscribed', async () => {
      const bus = new HookBus({});

      expect(await bus.chain('ldapsearchopts', { paged: true })).to.deep.equal({
        paged: true,
      });
      expect(bus.has('ldapsearchopts')).to.equal(false);
    });
  });

  describe('notify', () => {
    it('reports a hook that throws, and does not reject', async () => {
      setLogger(fakeLogger);
      const boom = new Error('boom');
      const bus = new HookBus({
        ldapadddone: [
          () => {
            throw boom;
          },
        ],
      });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});

      expect(reported).to.have.lengthOf(1);
      expect(reported[0][0]).to.equal('Hook error');
      expect(reported[0][1]).to.equal(boom);
    });

    it('runs the hooks that follow a failing one', async () => {
      setLogger(fakeLogger);
      const ran: string[] = [];
      const bus = new HookBus({
        ldapadddone: [
          () => {
            throw new Error('boom');
          },
          () => {
            ran.push('second');
          },
        ],
      });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});

      expect(ran).to.deep.equal(['second']);
    });

    it('names the hook and its plugin when registerPlugin recorded them', async () => {
      setLogger(fakeLogger);
      const boom = new Error('boom');
      const hook = (): never => {
        throw boom;
      };
      recordHookOwner(hook, 'james', 'ldapadddone');
      const bus = new HookBus({ ldapadddone: [hook] });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});

      expect(reported).to.have.lengthOf(1);
      expect(reported[0][0]).to.equal('Hook error in james (ldapadddone)');
      expect(reported[0][1]).to.equal(boom);
    });

    it("names a hook no plugin recorded by the function's own name", async () => {
      setLogger(fakeLogger);
      const bus = new HookBus({
        ldapadddone: [
          function pushedByHand(): never {
            throw 'refused';
          },
        ],
      });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});

      expect(reported[0][0]).to.equal('Hook error in pushedByHand: "refused"');
    });

    it('reports a thrown value that is not an Error', async () => {
      // winston keeps a second argument only when it is an object, so a hook
      // throwing a string would report `Hook error` and nothing more.
      setLogger(fakeLogger);
      const bus = new HookBus({
        ldapadddone: [
          () => {
            throw 'a string thrown';
          },
        ],
      });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});

      expect(reported).to.have.lengthOf(1);
      expect(reported[0][0]).to.equal('Hook error: "a string thrown"');
    });

    it('reports a circular thrown value without throwing itself', async () => {
      // The reporter runs inside the catch that exists to swallow; a value it
      // cannot describe must not become the failure it was reporting.
      setLogger(fakeLogger);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const bus = new HookBus({
        ldapadddone: [
          () => {
            throw circular;
          },
        ],
      });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});

      expect(reported).to.have.lengthOf(1);
      expect(reported[0][0]).to.equal('Hook error: [object Object]');
    });

    it('does not throw when no logger has been installed yet', async () => {
      // The app's order: this module is evaluated (through `ldapActions`)
      // before the `DM` constructor hands its logger to `setLogger`.
      setLogger(undefined);
      const bus = new HookBus({
        ldapadddone: [
          () => {
            throw new Error('boom');
          },
        ],
      });

      await bus.notifyAndWait('ldapadddone', 'cn=x', {});
    });

    it('is not awaited, and settled waits for it', async () => {
      let released: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        released = resolve;
      });
      const ran: string[] = [];
      const bus = new HookBus({
        ldapadddone: [
          async () => {
            await gate;
            ran.push('first');
          },
        ],
        ldapmodifydone: [
          async () => {
            // Started once settled is already waiting: it has to be waited
            // for too
            await gate;
            ran.push('second');
          },
        ],
      });

      bus.notify('ldapadddone', 'cn=x', {});
      let settled = false;
      const waiting = bus.settled().then(() => {
        settled = true;
      });
      bus.notify('ldapmodifydone', 'cn=y', {}, 1);
      await Promise.resolve();
      expect(ran, 'still running').to.deep.equal([]);
      expect(settled).to.equal(false);

      released();
      await waiting;

      expect(settled).to.equal(true);
      expect(ran).to.deep.equal(['first', 'second']);
    });
  });

  describe('notifyStrict', () => {
    it('runs every subscriber and raises the first failure', async () => {
      const ran: string[] = [];
      const bus = new HookBus({
        oidclogouttoken: [
          () => {
            throw new Error('first');
          },
          () => {
            ran.push('second');
          },
          () => {
            throw new Error('third');
          },
        ],
      });

      let message: string | undefined;
      await bus
        .notifyStrict('oidclogouttoken', { iss: 'p' })
        .catch((err: Error) => {
          message = err.message;
        });

      expect(ran).to.deep.equal(['second']);
      expect(message).to.equal('first');
    });
  });

  describe('prefixed', () => {
    it('raises the flat entity’s own hooks, under its prefix', async () => {
      const ran: string[] = [];
      const bus = new HookBus({
        ldapuseradddone: [(dn: string) => void ran.push(dn)],
      } as never);

      bus.prefixed('ldapuser').notify('adddone', 'cn=x');
      await bus.settled();

      expect(ran).to.deep.equal(['cn=x']);
    });
  });
});
