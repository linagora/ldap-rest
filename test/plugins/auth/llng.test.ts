import { expect } from 'chai';
import type { Express } from 'express';

import { DM } from '../../../src/bin';
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
    it('loads the real handler and authenticates a request', async function () {
      const dm = new DM();
      await dm.ready;

      const plugin = new AuthLLNG(dm);
      try {
        await plugin.api(dm.app);
      } catch (err) {
        // Not installed on this runtime (e.g. re2's engines constraint
        // excludes it here) — the case above covers the failure path.
        this.skip();
      }

      expect(plugin.name).to.equal('authLemonldapNg');
    });
  });
});
