import { expect } from 'chai';
import type { Express, Response } from 'express';

import { DM } from '../../../src/bin';
import type { DmRequest } from '../../../src/lib/auth/base';
import AuthLLNG from '../../../src/plugins/auth/llng';

/**
 * `lemonldap-ng-handler` is an optional dependency (it drags in the native
 * `re2` module, absent on some Node versions the project supports). This
 * subclass stands in for it being absent regardless of what is actually on
 * disk in the environment running the tests — the same way TestableRabbitMq
 * stands in for its broker client in test/plugins/rabbitmq.test.ts — so the
 * failure path is exercised on every runtime, not only the ones missing it.
 */
class MissingHandlerLLNG extends AuthLLNG {
  protected async loadHandler(): Promise<never> {
    throw new Error("Cannot find package 'lemonldap-ng-handler'");
  }
}

describe('LemonLDAP::NG auth plugin', () => {
  describe('when lemonldap-ng-handler is not installed', () => {
    it('fails loudly at startup, naming the plugin and the dependency', async () => {
      const dm = new DM();
      await dm.ready;

      const plugin = new MissingHandlerLLNG(dm);

      let thrown: Error | undefined;
      try {
        await plugin.api({} as Express);
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).to.be.instanceOf(Error);
      expect(thrown?.message).to.include(plugin.name);
      expect(thrown?.message).to.include('lemonldap-ng-handler');
    });
  });

  describe('when lemonldap-ng-handler is installed', () => {
    /**
     * The handler as the plugin sees it: `init()` records its arguments,
     * `run()` refuses to work before it — like the real module, whose `run()`
     * reads an instance only `init()` creates — and otherwise sets the header
     * a protected virtual host receives.
     */
    const fakeHandler = (options: { failInit?: Error } = {}) => {
      const calls: { init?: unknown } = {};
      let ready = false;
      const handler = {
        init: async (args: unknown): Promise<unknown> => {
          calls.init = args;
          if (options.failInit) throw options.failInit;
          ready = true;
          return {};
        },
        run: (
          req: { headers: Record<string, string> },
          _res: unknown,
          next: () => void
        ): void => {
          if (!ready)
            throw new TypeError(
              "Cannot read properties of undefined (reading 'run')"
            );
          req.headers['Lm-Remote-User'] = 'dwho';
          next();
        },
      };
      return { handler, calls };
    };

    const withHandler = (handler: unknown) =>
      class extends AuthLLNG {
        protected async loadHandler(): Promise<never> {
          return handler as never;
        }
      };

    it('initializes the handler from --llng-ini before serving', async () => {
      const dm = new DM();
      await dm.ready;
      dm.config.llng_ini = '/etc/llng/test.ini';
      const { handler, calls } = fakeHandler();
      const plugin = new (withHandler(handler))(dm);

      await plugin.api({} as Express);
      expect(calls.init).to.deep.equal({
        configStorage: { confFile: '/etc/llng/test.ini' },
      });

      const req = { headers: {} } as unknown as DmRequest;
      let passed = false;
      plugin.authMethod(req, {} as Response, () => {
        passed = true;
      });
      expect(passed).to.equal(true);
      expect(req.user).to.equal('dwho');
    });

    it('refuses a request the handler passed on without naming anyone', async () => {
      // `lemonldap-ng-handler` 3.x returns `next()` at once for a `skip`
      // rule — no session read, no header written. The plugin published
      // `undefined`, and every authorization plugin reads that as anonymous
      // and skips its check: an LLNG rule meaning "no authentication here"
      // became "authenticated, and scoped by nobody".
      const dm = new DM();
      await dm.ready;
      const silent = {
        init: async (): Promise<unknown> => ({}),
        run: (_req: unknown, _res: unknown, next: () => void): void => next(),
      };
      const plugin = new (withHandler(silent))(dm);
      await plugin.api({} as Express);

      const req = { headers: {} } as unknown as DmRequest;
      let passed = false;
      let status = 0;
      const res = {
        status: (code: number) => {
          status = code;
          return { json: (): void => undefined };
        },
      } as unknown as Response;
      plugin.authMethod(req, res, () => {
        passed = true;
      });
      expect(passed, 'nothing is served without an identity').to.equal(false);
      expect(status).to.equal(401);
      expect(req.user).to.equal(undefined);
    });

    it('does not read an identity the client supplied itself', async () => {
      // The handler writes `Lm-Remote-User`; Node lower-cases what arrives
      // on the wire, so the two spellings never collided and the safety of
      // the whole plugin rested on that. The header is now read whatever
      // its case — and whatever the client sent under it is dropped first.
      const dm = new DM();
      await dm.ready;
      const silent = {
        init: async (): Promise<unknown> => ({}),
        run: (_req: unknown, _res: unknown, next: () => void): void => next(),
      };
      const plugin = new (withHandler(silent))(dm);
      await plugin.api({} as Express);

      const req = {
        headers: { 'lm-remote-user': 'admin' },
      } as unknown as DmRequest;
      let passed = false;
      let status = 0;
      const res = {
        status: (code: number) => {
          status = code;
          return { json: (): void => undefined };
        },
      } as unknown as Response;
      plugin.authMethod(req, res, () => {
        passed = true;
      });
      expect(passed, 'a forged identity is not an identity').to.equal(false);
      expect(status).to.equal(401);
      expect(req.user).to.equal(undefined);
    });

    it('reads the identity whatever case the handler wrote it in', async () => {
      const dm = new DM();
      await dm.ready;
      const lowercasing = {
        init: async (): Promise<unknown> => ({}),
        run: (
          req: { headers: Record<string, string> },
          _res: unknown,
          next: () => void
        ): void => {
          // A handler version spelling it the way the wire does.
          req.headers['lm-remote-user'] = 'rtyler';
          next();
        },
      };
      const plugin = new (withHandler(lowercasing))(dm);
      await plugin.api({} as Express);

      const req = { headers: {} } as unknown as DmRequest;
      let passed = false;
      plugin.authMethod(req, {} as Response, () => {
        passed = true;
      });
      expect(passed).to.equal(true);
      expect(req.user).to.equal('rtyler');
    });

    it('fails at startup, naming the file, when the handler cannot start', async () => {
      const dm = new DM();
      await dm.ready;
      dm.config.llng_ini = '/nowhere/lemonldap-ng.ini';
      const { handler } = fakeHandler({
        failInit: new Error('No Virtualhosts configured for Node.js'),
      });
      const plugin = new (withHandler(handler))(dm);

      let thrown: Error | undefined;
      try {
        await plugin.api({} as Express);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown?.message).to.include(plugin.name);
      expect(thrown?.message).to.include('/nowhere/lemonldap-ng.ini');
      expect(thrown?.message).to.include('No Virtualhosts configured');
      // Nothing is served by a handler that did not start.
      expect(() =>
        plugin.authMethod(
          { headers: {} } as unknown as DmRequest,
          {} as Response,
          () => undefined
        )
      ).to.throw(/not loaded/);
    });

    it('refuses a second instance pointed at a different confFile, the handler being a module-level singleton', async () => {
      const dm = new DM();
      await dm.ready;
      const { handler } = fakeHandler();
      const LlngWithHandler = withHandler(handler);

      dm.config.llng_ini = '/etc/llng/first.ini';
      const first = new LlngWithHandler(dm);
      await first.api({} as Express);

      dm.config.llng_ini = '/etc/llng/second.ini';
      const second = new LlngWithHandler(dm);

      let thrown: Error | undefined;
      try {
        await second.api({} as Express);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown?.message).to.include(second.name);
      expect(thrown?.message).to.include('/etc/llng/first.ini');
      expect(thrown?.message).to.include('/etc/llng/second.ini');
    });

    it('accepts a second instance pointed at the same confFile', async () => {
      const dm = new DM();
      await dm.ready;
      const { handler } = fakeHandler();
      const LlngWithHandler = withHandler(handler);

      dm.config.llng_ini = '/etc/llng/shared.ini';
      const first = new LlngWithHandler(dm);
      await first.api({} as Express);

      const second = new LlngWithHandler(dm);
      await second.api({} as Express);
    });
  });
});
