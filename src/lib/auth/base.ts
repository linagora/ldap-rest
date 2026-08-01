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

/**
 * Tell whether a mount prefix covers a request path, with the rule Express
 * itself applies: on segment boundaries, so `/api/m` covers `/api/m` and
 * `/api/m/entry` but never `/api/machines`.
 *
 * The catch-all uses this to decide what another plugin already guards, so
 * it must agree with Express exactly — a looser rule here would skip paths
 * nobody guards.
 *
 * @param prefix mount prefix
 * @param path request path
 * @returns true when the prefix covers the path
 */
export function prefixCoversPath(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Path prefixes claimed by scoped authentication plugins.
 *
 * Takes the registry as an argument rather than reaching for the server, so
 * `DM` and `AuthBase` share one definition of what "claimed" means. The
 * registry is a live reference: it keeps filling as the remaining plugins
 * register, which is why the catch-all consults it per request.
 *
 * @param loadedPlugins the server's plugin registry
 * @param except name of the plugin asking, excluded from the result
 * @returns the prefixes other authentication plugins guard
 */
export function claimedPrefixes(
  loadedPlugins: Record<string, DmPlugin>,
  except?: string
): string[] {
  const claimed: string[] = [];
  for (const plugin of Object.values(loadedPlugins)) {
    if (plugin.name === except || !plugin.roles?.includes('auth')) continue;
    const prefixes = (plugin as DmPlugin & { pathPrefixes?: string[] })
      .pathPrefixes;
    if (prefixes?.length) claimed.push(...prefixes);
  }
  return claimed;
}

export default abstract class AuthBase extends DmPlugin {
  abstract authMethod(req: DmRequest, res: Response, next: () => void): void;

  /** Validated prefixes, computed once: the catch-all reads them per request */
  private _pathPrefixes?: string[];

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
   * A malformed entry is refused rather than skipped. Dropping one silently
   * would shrink what the plugin guards — the failure mode that leaves a
   * branch open while the configuration still reads as if it were covered.
   *
   * `/` is not a prefix but the whole server, so a list containing it makes
   * the plugin a catch-all: `["/", "/api/admin"]` guards everything, not
   * only `/api/admin`.
   *
   * @returns the configured prefixes without their trailing slashes, empty
   *          when the plugin guards the whole server
   * @throws Error when an entry is not a usable path prefix
   */
  get pathPrefixes(): string[] {
    if (this._pathPrefixes) return this._pathPrefixes;

    const configured = this.config.auth_path_prefix;
    const list = Array.isArray(configured)
      ? configured
      : configured
        ? [configured]
        : [];

    const prefixes: string[] = [];
    for (const entry of list) {
      // Plugin overrides are raw JSON, so an entry can be anything at all
      if (typeof entry !== 'string')
        throw new Error(
          `${this.name}: auth_path_prefix must contain strings, got ` +
            `${JSON.stringify(entry)}`
        );

      const trimmed = entry.trim();
      const prefix = stripTrailingSlashes(trimmed);
      if (prefix.length === 0) {
        if (trimmed.length === 0)
          throw new Error(
            `${this.name}: auth_path_prefix contains an empty entry`
          );
        // Only slashes: the plugin guards everything, whatever else is listed
        this.logger.info(
          `${this.name}: auth_path_prefix contains "${trimmed}", which covers ` +
            'the whole server: this authentication guards every path'
        );
        return (this._pathPrefixes = []);
      }
      if (!prefix.startsWith('/'))
        throw new Error(
          `${this.name}: auth_path_prefix entry "${entry}" must start with ` +
            '"/", otherwise it matches no request and guards nothing'
        );
      prefixes.push(prefix);
    }
    return (this._pathPrefixes = prefixes);
  }

  /**
   * Run this plugin's authentication on a request, hooks included.
   *
   * The dispatcher calls this; the plugin no longer owns a layer of its own.
   *
   * @param req incoming request
   * @param res response, ended here when authentication fails
   * @param next called only when the request is authenticated
   */
  async authenticate(
    req: Request,
    res: Response,
    next: () => void
  ): Promise<void> {
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
  }

  /**
   * Register with the server's authentication dispatcher instead of mounting
   * a middleware.
   *
   * Mounting per plugin made protection depend on registration order: a
   * plugin whose `app.use` landed after the routes it was meant to guard
   * never ran for them, and the catch-all — stepping aside for a branch that
   * guard was supposed to cover — turned that into anonymous access. The
   * dispatcher is mounted by `DM` before any plugin loads, so it always
   * precedes every route, whatever order the plugins register in.
   *
   * @param _app unused: the dispatcher owns the only authentication layer
   */
  api(_app: Express): void {
    const prefixes = this.pathPrefixes;
    this.server.registerAuthenticator(this);
    this.logger.info(
      prefixes.length === 0
        ? `${this.name}: authentication guards every path not claimed by another plugin`
        : `${this.name}: authentication restricted to ${prefixes.join(', ')}`
    );
  }
}
