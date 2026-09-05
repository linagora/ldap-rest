/**
 * @module plugins/auth/llng
 * @group Plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Lemonldap::NG authentication plugin
 * This plugin enables authentication and authorization using Lemonldap::NG.
 */
import type { Express, Response } from 'express';

import AuthBase, { DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

// The ambient declaration for `lemonldap-ng-handler` lives in
// src/types/lemonldap-ng-handler.d.ts: `skipLibCheck` lets that fallback
// coexist with the package's own types when it is installed, whereas the
// same declaration written here, in a regular source file, would conflict
// with them.
type LlngHandler = typeof import('lemonldap-ng-handler');

export default class AuthLLNG extends AuthBase {
  name = 'authLemonldapNg';
  roles: Role[] = ['auth'] as const;

  private handler?: LlngHandler;

  /**
   * Load the optional `lemonldap-ng-handler` dependency before the server
   * starts serving requests, rather than importing it statically.
   *
   * A static import would throw the moment this file is loaded — as soon as
   * this plugin is configured — with Node's own opaque "Cannot find
   * package" error. Loading it here instead means a server that never
   * configures this plugin never touches the package at all, and one that
   * does configure it gets a clear failure naming both the plugin and the
   * missing dependency, at startup, instead of on the first request an auth
   * plugin that cannot run must not pretend to succeed.
   */
  // AuthBase declares api() as returning void; DmPlugin's own api?() field
  // already allows MaybePromise<void>, and the caller in bin/index.ts always
  // awaits it — this override just uses the async result that permits.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async api(app: Express): Promise<void> {
    try {
      this.handler = await this.loadHandler();
    } catch (err) {
      throw new Error(
        `${this.name}: requires the optional dependency "lemonldap-ng-handler", ` +
          'which is not installed. Install it to use this plugin, or remove ' +
          `it from the configuration. (${
            err instanceof Error ? err.message : String(err)
          })`
      );
    }
    super.api(app);
  }

  /**
   * Load the handler. Split out so tests can override it to simulate the
   * dependency being absent, without actually uninstalling it.
   */
  protected async loadHandler(): Promise<LlngHandler> {
    return import('lemonldap-ng-handler');
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    // api() runs before any request reaches here and would already have
    // thrown if the dependency were missing, so this only guards against
    // authMethod being called out of order.
    if (!this.handler) {
      throw new Error(`${this.name}: lemonldap-ng-handler is not loaded`);
    }
    this.handler.run(req, res, () => {
      req.user = req.headers['Lm-Remote-User'] as string;
      next();
    });
  }
}
