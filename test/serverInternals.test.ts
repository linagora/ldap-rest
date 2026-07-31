import { expect } from 'chai';

import { DM } from '../src/bin';
import HelloWorld from '../src/plugins/demo/helloworld';
import RateLimit from '../src/plugins/auth/rateLimit';
import TrustedProxy from '../src/plugins/auth/trustedProxy';

/** Express 5 exposes the layer stack as `router`, Express 4 as `_router` */
interface AppInternal {
  router?: { stack: Array<{ handle: unknown }> };
  _router?: { stack: Array<{ handle: unknown }> };
}

/**
 * Count the error-handling layers of an app: Express recognises a middleware
 * as one by its arity, four arguments instead of three.
 *
 * @param dm server to inspect
 * @returns number of error middlewares in the stack
 */
function countErrorMiddlewares(dm: DM): number {
  const internal = dm.app as unknown as AppInternal;
  const stack = (internal.router ?? internal._router)?.stack || [];
  return stack.filter(
    layer => typeof layer.handle === 'function' && layer.handle.length === 4
  ).length;
}

/**
 * Capture what a server logs at a given level.
 *
 * @param dm server whose logger is replaced
 * @param level level to capture
 * @returns the collected messages, filled as they are logged
 */
function captureLogs(dm: DM, level: 'warn' | 'info'): string[] {
  const messages: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dm.logger as any)[level] = (message: string): unknown => {
    messages.push(message);
    return dm.logger;
  };
  return messages;
}

describe('Server internals', () => {
  describe('error middleware', () => {
    it('should keep exactly one however many plugins register', async () => {
      const dm = new DM();
      await dm.ready;
      expect(countErrorMiddlewares(dm)).to.equal(1);

      // Each registration re-runs setupErrorMiddleware, which must remove the
      // previous handler rather than stack another one on top
      for (const name of ['a', 'b', 'c'])
        await dm.registerPlugin(
          'core/demo/helloworld',
          new HelloWorld(dm),
          name
        );

      expect(countErrorMiddlewares(dm)).to.equal(1);
    });

    it('should keep the error middleware last', async () => {
      const dm = new DM();
      await dm.ready;
      await dm.registerPlugin('core/demo/helloworld', new HelloWorld(dm), 'z');

      const internal = dm.app as unknown as AppInternal;
      const stack = (internal.router ?? internal._router)?.stack || [];
      const last = stack[stack.length - 1];
      expect(typeof last.handle === 'function' && last.handle.length).to.equal(
        4
      );
    });
  });

  describe('duplicate plugin names', () => {
    it('should refuse the second instance and say why', async () => {
      const dm = new DM();
      await dm.ready;
      const warnings = captureLogs(dm, 'warn');

      const first = await dm.registerPlugin(
        'core/demo/helloworld',
        new HelloWorld(dm),
        'twice'
      );
      const second = await dm.registerPlugin(
        'core/demo/helloworld',
        new HelloWorld(dm),
        'twice'
      );

      expect(first).to.equal(true);
      expect(second).to.equal(false);
      // The message must name the culprit and the way out, since the symptom
      // is a 404 on routes the operator believes they configured
      const message = warnings.find(w => w.includes('twice'));
      expect(message, 'warning about the dropped instance').to.not.equal(
        undefined
      );
      expect(message).to.contain('dropped');
      expect(message).to.contain('give each one a name');
    });

    it('should collide on the name declared by the class when none is given', async () => {
      const dm = new DM();
      await dm.ready;
      captureLogs(dm, 'warn');

      // Both instances keep the class name `helloWorld`: the module path
      // passed as first argument is not an instance name
      expect(
        await dm.registerPlugin('core/demo/helloworld', new HelloWorld(dm))
      ).to.equal(true);
      expect(
        await dm.registerPlugin('core/demo/otherPath', new HelloWorld(dm))
      ).to.equal(false);
    });
  });

  describe('rate limiting without a trusted proxy', () => {
    it('should warn that the client IP can be forged', async () => {
      const dm = new DM();
      await dm.ready;
      const warnings = captureLogs(dm, 'warn');

      new RateLimit(dm).api(dm.app);

      const message = warnings.find(w => w.includes('X-Forwarded-For'));
      expect(message, 'warning about a forgeable key').to.not.equal(undefined);
      expect(message).to.contain('trustedProxy');
    });

    it('should stay silent when trustedProxy is loaded', async () => {
      const dm = new DM();
      await dm.ready;
      dm.config.trusted_proxy = ['127.0.0.1'];
      await dm.registerPlugin(
        'core/auth/trustedProxy',
        new TrustedProxy(dm),
        'trustedProxy'
      );

      const warnings = captureLogs(dm, 'warn');
      new RateLimit(dm).api(dm.app);

      expect(warnings.find(w => w.includes('X-Forwarded-For'))).to.equal(
        undefined
      );
    });
  });
});
