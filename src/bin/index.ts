/**
 * @packageDocumentation ldap-rest
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Main server file
 * It loads plugins, setup express app,... and start the server
 *
 * @example
 * const server = new DM();
 *
 * await server.ready;
 * await server.run();
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import express from 'express';
import bodyParser from 'body-parser';
import type winston from 'winston';
import type { Request, Response, NextFunction } from 'express';

import { parseConfig } from '../lib/parseConfig';
import configArgs, { type Config } from '../config/args';
import type { Hooks } from '../hooks';
import ldapActions from '../lib/ldapActions';
import type DmPlugin from '../abstract/plugin';
import { buildLogger } from '../logger/winston';
import { setLogger } from '../lib/expressFormatedResponses';
import AuthBase, { claimedPrefixes, prefixCoversPath } from '../lib/auth/base';
import pluginPriority from '../plugins/priority.json';

export type { Config };

// Internal Express router structure (used to remove error middleware and to
// list the registered routes when checking authentication coverage).
// Express 5 exposes it as `router`, Express 4 as `_router`.
interface ExpressRouterStack {
  stack: Array<{
    handle: unknown;
    route?: { path?: string | string[] };
  }>;
}
interface ExpressAppInternal {
  router?: ExpressRouterStack;
  _router?: ExpressRouterStack;
}

export * from '../lib/utils';
export { asyncHandler } from '../lib/utils';
export {
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UriTooLongError,
  TooManyRequestsError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
} from '../lib/errors';

//export const build = () => {

/**
 * @class DM
 */
export class DM {
  app: express.Express;
  config: Config;
  ready: Promise<void>;
  server?: import('http').Server;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  hooks: { [K in keyof Hooks]?: Function[] } = {};
  loadedPlugins: { [key: string]: DmPlugin } = {};
  ldap: ldapActions;
  operationSequence: number;
  logger: winston.Logger;
  /** Authentication plugins, in registration order */
  authenticators: AuthBase[] = [];
  private _authDispatcherMounted = false;
  private _errorMiddlewareSetup: boolean = false;
  private _errorMiddleware?: express.ErrorRequestHandler;

  constructor() {
    this.config = parseConfig(configArgs);

    this.app = express();
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({ extended: true }));
    this.logger = buildLogger(this.config);
    this.ldap = new ldapActions(this);
    setLogger(this.logger);
    this.operationSequence = 0;
    const promises: Promise<void | boolean>[] = [];

    if (this.config.plugin) {
      // Separate configApi from other plugins
      const configApiPlugin = this.config.plugin.find(p =>
        p.includes('configApi')
      );
      let regularPlugins = this.config.plugin.filter(
        p => !p.includes('configApi')
      );

      // Load priority plugins first sequentially to ensure proper middleware order
      const priorityPromise = (async () => {
        for (const p of pluginPriority) {
          if (regularPlugins.includes(p)) {
            regularPlugins = regularPlugins.filter(pl => pl !== p);
            await this.loadPlugin(p);
          }
        }
      })();
      promises.push(priorityPromise);

      // Load remaining plugins in parallel after priority plugins
      promises.push(
        priorityPromise.then(async () => {
          const regularPromises = regularPlugins.map(pluginName =>
            this.loadPlugin(pluginName)
          );
          await Promise.all(regularPromises);
        })
      );

      // Load configApi last
      if (configApiPlugin) {
        promises.push(
          Promise.all(promises).then(() => this.loadPlugin(configApiPlugin))
        );
      }
    }
    this.ready = new Promise((resolve, reject) => {
      if (promises.length > 0) {
        Promise.all(promises)
          .then(() => {
            this.setupErrorMiddleware();
            this.warnUnauthenticatedRoutes();
            resolve();
          })
          .catch(err => reject(new Error('Error loading plugins: ' + err)));
      } else {
        this.setupErrorMiddleware();
        resolve();
      }
    });
  }

  /**
   * The Express router stack, whatever the Express version calls it: 5
   * exposes `router`, 4 exposed `_router`.
   *
   * @returns the layer stack, or undefined when Express hides it
   */
  private routerStack(): ExpressRouterStack['stack'] | undefined {
    const internal = this.app as unknown as ExpressAppInternal;
    return (internal.router ?? internal._router)?.stack;
  }

  /**
   * A view of this server carrying a different configuration, handed to a
   * plugin loaded with overrides (`module:name:{json}`).
   *
   * Everything is shared by reference — the Express app, the hooks, the LDAP
   * connection, the plugin registry — so the plugin acts on this server; only
   * `config` differs. The copy is built on this instance's prototype rather
   * than by spreading it: `{...this}` copies own properties and leaves the
   * methods behind, so a plugin calling `this.server.anything()` would throw,
   * and only when configured with overrides — the kind of failure that shows
   * up in production and not in a test that instantiates the plugin directly.
   *
   * @param config configuration the plugin must see
   * @returns a server view backed by this instance
   */
  withConfig(config: Config): DM {
    return Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as DM,
      this,
      { config }
    );
  }

  /**
   * Mount the authentication dispatcher, once, before the first plugin that
   * can register a route.
   *
   * Position is the whole point. Guards (`protect`: rate limiting, proxy
   * trust, CrowdSec) and access logging must see a request *before*
   * authentication — a rate limiter that runs after a 401 never gets to
   * answer 429, and `trustedProxy` strips forged `X-Forwarded-For` headers
   * that authentication relies on. Everything else may register routes, and
   * a route must never precede authentication: mounting one layer here, at
   * the boundary between the two, is what makes protection independent of
   * the order plugins happen to load in.
   *
   * @param plugin the plugin about to register
   */
  private mountAuthDispatcher(plugin: DmPlugin): void {
    const roles = plugin.roles || [];
    if (roles.includes('protect') || roles.includes('logging')) return;
    this.mountAuthDispatcherNow();
  }

  /** Mount the dispatcher layer if it is not mounted yet */
  private mountAuthDispatcherNow(): void {
    if (this._authDispatcherMounted) return;
    this._authDispatcherMounted = true;
    this.app.use((req, res, next) => {
      this.dispatchAuth(req, res, next);
    });
  }

  /**
   * Add an authentication plugin to the dispatcher.
   *
   * Mounts the dispatcher too: a plugin may call `api()` directly instead of
   * going through `registerPlugin`, and authentication that registers but is
   * never dispatched would leave the server open.
   *
   * @param plugin plugin whose `authenticate` guards the paths it claims
   */
  registerAuthenticator(plugin: AuthBase): void {
    this.mountAuthDispatcherNow();
    if (!this.authenticators.includes(plugin)) this.authenticators.push(plugin);
  }

  /**
   * Pick the authentication a request must satisfy, and run it.
   *
   * The most specific claim wins: a plugin scoped to `/api/admin` guards that
   * branch alone, a plugin scoped to `/api` guards the rest of `/api`, and an
   * unscoped plugin guards everything nobody claimed. Only the winners run,
   * so two plugins covering the same request never compose as an AND that no
   * credential can satisfy.
   *
   * Several plugins sharing the same winning prefix all run, in registration
   * order: asking for two credentials on one branch is a legitimate ask, and
   * an accident there fails closed.
   *
   * A path no plugin claims, with no unscoped plugin loaded, passes through
   * unauthenticated — the gap `warnUnauthenticatedRoutes` names at startup.
   *
   * @param req incoming request
   * @param res response, ended by the plugin when authentication fails
   * @param next called when the request is authenticated, or when no
   *             authentication applies to its path
   */
  dispatchAuth(req: Request, res: Response, next: () => void): void {
    let winning = -1;
    let selected: AuthBase[] = [];
    for (const plugin of this.authenticators) {
      for (const prefix of plugin.pathPrefixes) {
        if (!prefixCoversPath(prefix, req.path)) continue;
        if (prefix.length > winning) {
          winning = prefix.length;
          selected = [plugin];
        } else if (prefix.length === winning && !selected.includes(plugin))
          selected.push(plugin);
      }
    }
    if (winning < 0)
      selected = this.authenticators.filter(p => p.pathPrefixes.length === 0);
    if (selected.length === 0) return next();

    // Every selected plugin must let the request through
    const run = (index: number): void => {
      if (index >= selected.length) return next();
      void selected[index].authenticate(req, res, () => run(index + 1));
    };
    run(0);
  }

  /**
   * Path prefixes claimed by scoped authentication plugins.
   *
   * An unscoped plugin subtracts these from what it guards, so a
   * configuration can say "OIDC on /api/admin, token everywhere else"
   * without anyone maintaining the list of everywhere else.
   *
   * @param except name of the plugin asking, excluded from the result
   * @returns the prefixes other authentication plugins guard
   */
  claimedAuthPrefixes(except?: string): string[] {
    return claimedPrefixes(this.loadedPlugins, except);
  }

  /**
   * List the routes no authentication plugin guards, once every plugin is
   * loaded.
   *
   * Scoping authentication to a path prefix is what lets one server host
   * populations that authenticate differently, but it also means a route
   * registered outside every prefix is served to anyone. That gap is silent
   * — the server starts, the API answers — so it is named at startup.
   *
   * Nothing is reported when no authentication is configured at all (the
   * server is open on purpose) or when one plugin guards every path.
   *
   * @returns the unguarded route paths, for tests and callers
   */
  warnUnauthenticatedRoutes(): string[] {
    const authPlugins = Object.values(this.loadedPlugins).filter(p =>
      p.roles?.includes('auth')
    ) as Array<DmPlugin & { pathPrefixes?: string[] }>;
    if (authPlugins.length === 0) return [];

    const prefixes: string[] = [];
    for (const plugin of authPlugins) {
      // A plugin without prefixes guards everything: nothing can be exposed
      if (!plugin.pathPrefixes || plugin.pathPrefixes.length === 0) return [];
      prefixes.push(...plugin.pathPrefixes);
    }

    const stack = this.routerStack();
    const paths = new Set<string>();
    for (const layer of stack || []) {
      const path = layer.route?.path;
      if (typeof path === 'string') paths.add(path);
      else if (Array.isArray(path))
        path.forEach(p => typeof p === 'string' && paths.add(p));
    }

    const unguarded = [...paths].filter(
      path =>
        !prefixes.some(
          prefix => path === prefix || path.startsWith(`${prefix}/`)
        )
    );
    if (unguarded.length > 0)
      this.logger.warn(
        `Authentication is restricted to ${prefixes.join(', ')}, so these ` +
          `routes are served without authentication: ${unguarded.sort().join(', ')}`
      );
    return unguarded.sort();
  }

  setupErrorMiddleware(): void {
    // Remove existing error middleware if already set up.
    // Express 5 renamed `_router` to `router`, so this lookup silently found
    // nothing and the old handler was never removed: one more was appended on
    // every registerPlugin. Only the first ever ran, so nothing broke — the
    // stack just kept growing.
    if (this._errorMiddlewareSetup && this._errorMiddleware) {
      const stack = this.routerStack();
      if (stack) {
        const index = stack.findIndex(
          layer => layer.handle === this._errorMiddleware
        );
        if (index !== -1) {
          stack.splice(index, 1);
        }
      }
    }

    // Create error handling middleware - must be after all routes
    this._errorMiddleware = (
      err: Error,
      req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      let statusCode =
        'statusCode' in err ? (err as { statusCode: number }).statusCode : 500;

      // Recognise the authz-forbidden marker embedded by authz plugins so a
      // 403 survives being wrapped into a plain Error by downstream callers
      // (which otherwise drops `statusCode` and surfaces as a 500).
      let clientMessage = err.message;
      if (statusCode === 500 && /\[authz-forbidden\]/.test(err.message)) {
        statusCode = 403;
        clientMessage = 'Token does not have permission on this branch';
      } else if (
        statusCode === 403 &&
        /\[authz-forbidden\]/.test(err.message)
      ) {
        clientMessage = 'Token does not have permission on this branch';
      }

      // Client error (4xx) - log as warning and return error message
      if (statusCode >= 400 && statusCode < 500) {
        this.logger.warn(
          `Client error ${statusCode} in request ${req.method} ${req.path}: ${clientMessage}`
        );
        if (!res.headersSent) {
          return res.status(statusCode).json({ error: clientMessage });
        }
        return;
      }

      // Server error (5xx) - log as error and hide details
      this.logger.error(
        `Server error ${statusCode} in request ${req.method} ${req.path}: ${err.message}`,
        {
          stack: err.stack,
          url: req.url,
          method: req.method,
        }
      );

      if (!res.headersSent) {
        res.status(statusCode).json({
          error: 'Internal Server Error',
          message: this.config.debug ? err.message : 'An error occurred',
        });
      }
    };

    this.app.use(this._errorMiddleware);
    this._errorMiddlewareSetup = true;
  }

  run(): Promise<void> {
    // Handle uncaught exceptions
    process.on('uncaughtException', (err: Error) => {
      this.logger.error(`Uncaught exception: ${err.message}`, {
        stack: err.stack,
      });
      // Don't exit the process, just log the error
    });

    // Handle unhandled promise rejections
    process.on(
      'unhandledRejection',
      (reason: unknown, promise: Promise<unknown>) => {
        this.logger.error(`Unhandled promise rejection: ${reason as string}`, {
          reason,
          promise,
        });
        // Don't exit the process, just log the error
      }
    );

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, err => {
        if (err) {
          this.logger.error(`Error starting server: ${err}`);
          reject(err);
        } else {
          this.logger.debug(`Server started on port ${this.config.port}`);
          resolve();
        }
      });
    });
  }

  stop(): void {
    this.app.removeAllListeners();
    this.server?.close();
    this.logger.debug('Server stopped');
  }

  loadPlugin(pluginName: string): Promise<boolean> {
    let name: string | undefined;
    let overrides: Config | undefined;
    if (/:/.test(pluginName)) {
      let tmp: string = pluginName.substring(pluginName.indexOf(':') + 1);
      pluginName = pluginName.substring(0, pluginName.indexOf(':'));
      if (/:/.test(tmp)) {
        name = tmp.substring(0, tmp.indexOf(':'));
        if (!name) name = undefined;
        tmp = tmp.substring(tmp.indexOf(':') + 1);
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          overrides = JSON.parse(tmp);
          if (typeof overrides !== 'object') {
            this.logger.error(
              `Overrides for plugin ${pluginName} are not valid: ${tmp}`
            );
            overrides = undefined;
          } else {
            this.logger.debug(
              `Overrides for plugin ${name || pluginName}: ${tmp}`
            );
          }
        } catch (err) {
          this.logger.error(
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            `Failed to parse overrides for plugin ${pluginName}: ${err}, using ${tmp}`
          );
          overrides = undefined;
        }
      } else {
        name = tmp;
        if (!name) name = undefined;
      }
    } else {
      name = undefined;
    }
    this.logger.debug(`Loading plugin ${pluginName}`);
    if (pluginName.startsWith('core/')) {
      pluginName = pluginName
        .replace(
          'core/',
          join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins') + '/'
        )
        .replace(/$/, '.js');
    }
    return new Promise<boolean>((resolve, reject) => {
      import(pluginName)
        .then(async pluginModule => {
          if (pluginModule && pluginModule.default) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            pluginModule = pluginModule.default;
          }
          let obj;
          if (overrides) {
            const newConfig = { ...this.config, ...overrides };
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            obj = new pluginModule(this.withConfig(newConfig));
          } else {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            obj = new pluginModule(this);
          }
          if (!obj) return reject(new Error(`Unable to load ${pluginName}`));
          resolve(await this.registerPlugin(pluginName, obj as DmPlugin, name));
          this.logger.debug(`Plugin ${obj.name} loaded`);
        })
        .catch(err =>
          reject(new Error(`Failed to load plugin ${pluginName}: ${err}`))
        );
    });
  }

  async registerPlugin(
    pluginName: string,
    obj: DmPlugin,
    name?: string
  ): Promise<boolean> {
    if (!obj.name) obj.name = pluginName;
    if (name) obj.name = name;
    if (this.loadedPlugins[obj.name]) {
      // Dropping the instance silently is what makes this expensive to
      // debug: its api() is never called, so its routes simply do not exist
      // and every request to them answers 404 with nothing in the log to
      // explain why. Loading a plugin twice on purpose needs a distinct name.
      this.logger.warn(
        `Plugin ${pluginName} not registered: the name "${obj.name}" is ` +
          'already taken. This instance is dropped and its routes will not ' +
          'exist. To load the same plugin twice, give each one a name: ' +
          `--plugin '${pluginName}:${obj.name}2:{…}'`
      );
      return false;
    }
    this.logger.debug(`Registering plugin ${pluginName} as ${obj.name}`);
    if (obj.dependencies) {
      for (const dependency in obj.dependencies) {
        if (!this.loadedPlugins[dependency]) {
          this.logger.debug(
            `Plugin ${obj.name} depends on ${dependency}, loading it first`
          );
          await this.loadPlugin(obj.dependencies[dependency]);
        }
      }
    }
    if (obj.api) {
      this.mountAuthDispatcher(obj);
      this.logger.debug(`Plugin ${obj.name} has API, registering it`);
      await obj.api(this.app);
      // If error middleware was already setup, re-setup it to ensure it stays at the end
      if (this._errorMiddlewareSetup) {
        this.setupErrorMiddleware();
      }
    }
    if (obj.hooks as Hooks) {
      for (const hookName in obj.hooks as Hooks) {
        this.logger.debug(
          `Plugin ${obj.name} has hook ${hookName}, registering it`
        );
        const hook = (obj.hooks as Hooks)[hookName as keyof Hooks];
        if (!this.hooks[hookName as keyof Hooks]) {
          this.hooks[hookName as keyof Hooks] = [];
        }
        if (hook && typeof hook === 'function') {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore: object is defined
          this.hooks[hookName as keyof Hooks].push(hook);
        } else {
          throw new Error(`Plugin ${obj.name}: hook ${hookName} is invalid`);
        }
      }
    }
    this.loadedPlugins[obj.name] = obj;
    return true;
  }
}
