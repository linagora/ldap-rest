import type { Express, Request, Response } from 'express';

export type DmRequest = Request & { user?: string };

// eslint-disable-next-line import/order
import DmPlugin from '../../abstract/plugin';

import { serverError } from '../../lib/expressFormatedResponses';
import { launchHooksChained } from '../../lib/utils';

/**
 * Drop the trailing slashes of a path prefix.
 *
 * Written as a scan rather than a `/\/+$/` replacement: that pattern
 * backtracks quadratically on a long run of slashes, which CodeQL flags as
 * a polynomial ReDoS. The value comes from the configuration rather than
 * from a request, so nothing was exploitable — but a linear scan says what
 * it does and costs nothing.
 *
 * @param path prefix to clean
 * @returns the prefix without its trailing slashes
 */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

export default abstract class AuthBase extends DmPlugin {
  abstract authMethod(req: DmRequest, res: Response, next: () => void): void;

  /**
   * Path prefixes this authentication applies to, empty when it guards the
   * whole server.
   *
   * Loading the same plugin twice with different prefixes lets one server
   * serve populations that authenticate differently — machines with a token
   * on one branch of the API, administrators with an SSO session on another:
   *
   * ```
   * --plugin 'core/auth/token:tok:{"auth_path_prefix":"/api/m"}'
   * --plugin 'core/auth/openidconnect:oidc:{"auth_path_prefix":"/api/admin"}'
   * ```
   *
   * A credential is then only valid on the branch it was scoped to, which is
   * the point: a leaked machine token buys nothing on the admin API.
   *
   * @returns the configured prefixes, without trailing slashes
   */
  get pathPrefixes(): string[] {
    const configured = this.config.auth_path_prefix;
    const list = Array.isArray(configured)
      ? configured
      : configured
        ? [configured]
        : [];
    return list
      .map(p => stripTrailingSlashes(p.trim()))
      .filter(p => p.length > 0);
  }

  api(app: Express): void {
    const prefixes = this.pathPrefixes;

    const middleware = async (
      req: Request,
      res: Response,
      next: () => void
    ): Promise<void> => {
      try {
        [req, res] = await launchHooksChained(this.server.hooks.beforeAuth, [
          req,
          res,
        ]);
      } catch (err) {
        return serverError(res, err as Error);
      }
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.authMethod(req, res, async (): Promise<void> => {
        try {
          if (this.hooks?.onAuth) {
            [req, res] = await launchHooksChained(this.server.hooks.afterAuth, [
              req,
              res,
            ]);
          }
          next();
        } catch (err) {
          serverError(res, err as Error);
        }
      });
    };

    if (prefixes.length === 0) {
      app.use(middleware);
      return;
    }

    // Express matches a mount path on segment boundaries, so `/api/m` guards
    // `/api/m` and `/api/m/entry` without ever catching `/api/machines`
    app.use(prefixes, middleware);
    this.logger.info(
      `${this.name}: authentication restricted to ${prefixes.join(', ')}`
    );
  }
}
