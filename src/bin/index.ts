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
import { keepRawBody } from '../lib/rawBody';
import configArgs, { type Config } from '../config/args';
import type { Hooks } from '../hooks';
import ldapActions from '../lib/ldapActions';
import type DmPlugin from '../abstract/plugin';
import { buildLogger } from '../logger/winston';
import {
  serverErrorBody,
  setDebug,
  setLogger,
} from '../lib/expressFormatedResponses';
import AuthBase, { prefixCoversPath, type DmRequest } from '../lib/auth/base';
import {
  assertAuthzComposition,
  assertEnforceable,
  LDAP_JUDGING_HOOKS,
} from '../lib/authz/composition';
import { AUTHZ_REFUSED, errorBody } from '../lib/errors';
import { registerAttributeTypes } from '../lib/utils';
import HookBus, { recordHookOwner, type HookFn } from '../lib/hookBus';
import { runForRequest, runWithLogContext } from '../lib/requestContext';
import { requestId } from '../lib/changeContext';
import { HEALTH_PATHS, mountHealth } from '../lib/health';
import {
  httpRequestDuration,
  routeTemplate,
  secondsSince,
  unhandledRejections,
} from '../lib/metrics';
import { registerProcessShutdown, shutdownTimeout } from '../lib/shutdown';
import pluginPriority from '../plugins/priority.json';

export type { Config };

/**
 * The hooks an authorization plugin refuses a request from, which run before
 * any other plugin's whatever the order the plugins loaded in.
 *
 * The first hook to throw answers the request. A plugin judging a write on
 * its content — `enterpriseRules` answering 409 "already used", or "still
 * referenced" — therefore told a caller who may not write there what the
 * directory holds where they cannot read, one request at a time, and told
 * them to fix a write they would then be refused anyway. A plugin replacing
 * a write — `trash` moving an entry instead of deleting it — did it before
 * anyone judged the delete. Which came first was the order the plugins'
 * imports completed in. The authorization plugins keep their own order
 * among themselves: they compose as an AND, the first refusal winning.
 *
 * `ldapsearchfilter` is not here: it narrows a result already read rather
 * than refusing a request, and plugins rely on what it leaves.
 */
const AUTHZ_FIRST_HOOKS: string[] = LDAP_JUDGING_HOOKS.filter(
  hook => hook !== 'ldapsearchfilter'
);

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
  /** The listener, once `run()` opened it; shared by the `withConfig` views */
  get server(): import('http').Server | undefined {
    return this.life.server;
  }
  set server(server: import('http').Server | undefined) {
    this.life.server = server;
  }
  /**
   * What each hook's subscribers do, as a plugin declares them. The type
   * names every hook: raising or subscribing to one goes through `hookBus`,
   * which checks the arguments.
   */
  hooks: Hooks = {};
  readonly hookBus: HookBus = new HookBus(this.hooks);
  loadedPlugins: { [key: string]: DmPlugin } = {};
  ldap: ldapActions;
  operationSequence: number;
  logger: winston.Logger;
  /** Authentication plugins, in registration order */
  authenticators: AuthBase[] = [];
  /**
   * Held in an object, not a boolean field: `withConfig` copies own
   * properties, so a plain flag would be duplicated per configured plugin and
   * each clone would mount a dispatcher of its own — authentication running
   * as many times as there are plugins, which a one-shot method like TOTP
   * fails on the second pass. An object is copied by reference and stays
   * shared.
   */
  private _authState: { dispatcherMounted: boolean } = {
    dispatcherMounted: false,
  };
  private _errorMiddlewareSetup: boolean = false;
  /** The parsers plugins mount ahead of the global ones, see registerBodyParser */
  private readonly bodyParsers = express.Router();
  /**
   * Whether the plugins of the configuration are loaded and their
   * composition checked. A plugin registered after that — a server
   * assembled by hand — is checked on its own as it arrives.
   */
  private _composed: boolean = false;

  /** Every plugin loaded and the composition checked */
  get composed(): boolean {
    return this._composed;
  }

  /**
   * The listener, the shutdown once started, and the rejections nobody
   * handled since the start. In an object, shared by the `withConfig` views
   * as `_authState` is: a view with a flag of its own would stop on its own,
   * and one without the listener would not close it.
   */
  private readonly life: {
    server?: import('http').Server;
    shutdown?: Promise<void>;
    unhandledRejections: number;
  } = { unhandledRejections: 0 };

  /** The responses not sent yet, told to close their connection on a stop */
  private readonly inFlight = new Set<Response>();

  /** Told to stop: the readiness says so, what is in flight finishes */
  get stopping(): boolean {
    return this.life.shutdown !== undefined;
  }

  /** Rejections nobody handled since the start, logged and counted */
  get unhandledRejections(): number {
    return this.life.unhandledRejections;
  }
  private _errorMiddleware?: express.ErrorRequestHandler;
  /**
   * The loads of `--plugin` entries without overrides, keyed by resolved
   * module and name. Regular plugins load in parallel and load their own
   * dependencies, so one module is often asked for twice: in the
   * configuration and by a plugin depending on it, or listed twice. The
   * second request waits for the first rather than building an instance
   * whose name is taken. A Map, so that `withConfig` views share it.
   */
  private readonly pluginLoads = new Map<string, Promise<boolean>>();
  /**
   * The request hooks of the authorization plugins, which `registerPlugin`
   * keeps ahead of every other plugin's. See {@link AUTHZ_FIRST_HOOKS}.
   */
  private readonly authzHooks = new WeakSet<object>();

  constructor() {
    this.config = parseConfig(configArgs);

    this.app = express();
    // Nothing tells which framework answers, and no script or style is
    // read as another type than the one its response declares.
    this.app.disable('x-powered-by');
    this.app.use((req, res, next) => {
      const started = process.hrtime.bigint();
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // A stopping server closes the connection with the response: a
      // keep-alive connection would otherwise bring requests until it is
      // cut. The header does it for a response not sent yet; a response
      // whose headers went out before the stop leaves an idle connection
      // once sent, which `closeIdleConnections` closes.
      if (this.stopping) res.setHeader('Connection', 'close');
      this.inFlight.add(res);
      res.once('finish', () => {
        httpRequestDuration.observe(
          {
            method: req.method,
            route: routeTemplate(req),
            status: String(res.statusCode),
          },
          secondsSince(started)
        );
        if (this.stopping) this.server?.closeIdleConnections();
      });
      res.once('close', () => this.inFlight.delete(res));
      next();
    });
    // Every answer names its request, and every line logged while serving
    // it carries the name, a body refused by a parser included; see
    // docs/usage/operations.md#request-id
    this.app.use((req, res, next) => {
      const id = requestId(req);
      res.setHeader('X-Request-Id', id);
      runWithLogContext({ requestId: id }, next);
    });
    // Each parser keeps the bytes it read: core/auth/hmac hashes those, as
    // the client signed them, not the body re-serialized.
    this.app.use(this.bodyParsers);
    this.app.use(bodyParser.json({ verify: keepRawBody }));
    this.app.use(
      bodyParser.urlencoded({ extended: true, verify: keepRawBody })
    );
    // Before the authentication: a probe carries no identity
    mountHealth(this.app, this);
    this.logger = buildLogger(this.config);
    this.ldap = new ldapActions(this);
    setLogger(this.logger);
    setDebug(this.config.debug);
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

      // Load priority plugins first sequentially to ensure proper middleware
      // order.
      //
      // Matched on the module, not on the whole `--plugin` string. An entry
      // carrying a name and overrides — `module:name:{json}`, the only form
      // that can hold a per-instance option — is never equal to the bare
      // module name, so every named instance used to leave this pass for the
      // parallel batch, where the order is import completion. A named
      // `core/auth/trustedProxy` then registered after the routes it was
      // meant to guard, and a forged `X-Forwarded-For` reached them — which
      // is what `rateLimit` and `crowdsec` key on.
      //
      // Every instance of a priority module is loaded here, in configuration
      // order: two instances of one module are a deliberate configuration
      // (each guarding its own prefix), and splitting them across the two
      // passes would put one of them after the routes.
      // Captured: inside the closure below, the compiler no longer follows
      // that the constructor has already built it.
      const logger = this.logger;
      const priorityPromise = (async (): Promise<void> => {
        for (const p of pluginPriority) {
          const target = this.resolveModule(DM.moduleOf(p));
          const matching = regularPlugins.filter(
            entry => this.resolveModule(DM.moduleOf(entry)) === target
          );
          if (matching.length === 0) continue;
          regularPlugins = regularPlugins.filter(
            entry => !matching.includes(entry)
          );
          for (const entry of matching) {
            logger.debug(`Loading ${entry} in the priority pass`);
            await this.loadPlugin(entry);
          }
        }
      })();
      promises.push(priorityPromise);

      // Load remaining plugins in parallel after priority plugins
      promises.push(
        priorityPromise.then(async () => {
          const regularPromises = regularPlugins.map(pluginName => {
            // Which pass loaded what is otherwise invisible, and a plugin
            // that lost its rank is invisible with it.
            logger.debug(`Loading ${pluginName} in the parallel batch`);
            return this.loadPlugin(pluginName);
          });
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
          .then(async () => {
            this.setupErrorMiddleware();
            this.warnUnauthenticatedRoutes();
            // Before `afterLoad`, and outside it: a plugin's opinion there is
            // logged and served anyway, while two authorization models
            // judging the same requests is a configuration nobody decided,
            // and the server does not start on it.
            await assertAuthzComposition(this);
            assertEnforceable(this);
            await this.learnAttributeTypes();
            this._composed = true;
            this.afterLoad();
            resolve();
          })
          .catch(err => reject(new Error('Error loading plugins: ' + err)));
      } else {
        // No plugin yet: a host assembling the server registers its own,
        // and answers for what they enforce
        this.setupErrorMiddleware();
        this._composed = true;
        resolve();
      }
    });
  }

  /**
   * Teach DN comparisons the names and OIDs of the directory's attribute
   * types, when a plugin judges requests by DN: OpenLDAP reads
   * `2.5.4.11=payroll` as `ou=payroll`, and a rule on the one must hold the
   * other. Without the schema, the usual types are still known.
   */
  private async learnAttributeTypes(): Promise<void> {
    if (
      !Object.values(this.loadedPlugins).some(plugin =>
        plugin.roles?.includes('authz')
      )
    )
      return;
    try {
      registerAttributeTypes(
        (await this.ldap.schemaIndex()).schema.attributeTypes
      );
    } catch (err) {
      this.logger.warn(
        `Could not read the directory schema, DNs are compared with the usual attribute type names only: ${String(err)}`
      );
    }
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
    if (this._authState.dispatcherMounted) return;
    this._authState.dispatcherMounted = true;
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
   * Parse the bodies under `path` with `parser`, ahead of the global JSON and
   * form parsers, which then leave them alone: for another media type or
   * size limit there. Authentication runs before the routes, so a parser
   * mounted by a route would come too late for core/auth/hmac.
   *
   * `jsonBodyParser` builds a JSON one that keeps the bytes it reads; any
   * other must pass `keepRawBody` as `verify`: core/auth/hmac refuses a body
   * whose bytes were not kept.
   *
   * @param path the prefix whose bodies `parser` reads
   * @param parser a body-parser middleware
   */
  registerBodyParser(path: string, parser: express.RequestHandler): void {
    this.bodyParsers.use(path, parser);
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

    // A verdict a plugin could not reach on its own, once every
    // authenticator has run.
    //
    // This is the only point that is after the whole chain and before any
    // route: a plugin mounting its own middleware for it would land wherever
    // its registration fell among the others, and a route plugin registered
    // first would answer before the refusal — registration order deciding an
    // authorization answer, in the direction that fails open.
    // Let through: what serves the request is made for it, whether or not
    // the request is handed down (#385)
    const finish = (index: number): void => {
      if (index >= selected.length) return runForRequest(req, next);
      const plugin = selected[index];
      if (!plugin.afterChain) return finish(index + 1);
      plugin.afterChain(req, res, () => finish(index + 1));
    };
    // Every selected plugin must let the request through, and the ones that
    // vouched for it are recorded as they do: an authorization plugin scoped
    // with `--authz-for` reads that list to tell whose request it is. The
    // continuation only runs on success, so recording there costs nothing and
    // cannot record a plugin that refused. The list is set here rather than
    // grown from whatever the request carried in: only this dispatcher writes
    // it.
    const vouched: string[] = [];
    (req as DmRequest).authenticators = vouched;
    const run = (index: number): void => {
      if (index >= selected.length) return finish(0);
      const plugin = selected[index];
      void plugin.authenticate(req, res, () => {
        if (plugin.vouchedFor(req)) vouched.push(plugin.name);
        run(index + 1);
      });
    };
    run(0);
  }

  /**
   * Let every loaded plugin look at the configuration as a whole.
   *
   * Constructors and `api()` run while the rest is still loading, so a
   * plugin cannot see there what it is loaded *beside*. A failure here is
   * reported and does not stop the server: it is a plugin's opinion about a
   * configuration, not a condition for serving it.
   */
  afterLoad(): void {
    for (const plugin of Object.values(this.loadedPlugins)) {
      try {
        plugin.afterLoad?.();
      } catch (err) {
        this.logger.error(
          `Plugin ${plugin.name}: afterLoad failed: ${String(err)}`
        );
      }
    }
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

    // The probes carry no identity by design: a kubelet has none
    const unguarded = [...paths].filter(
      path =>
        !(HEALTH_PATHS as readonly string[]).includes(path) &&
        !prefixes.some(
          prefix => path === prefix || path.startsWith(`${prefix}/`)
        )
    );
    // No identity there, so no authorization plugin judges them either
    const judged = Object.values(this.loadedPlugins).some(p =>
      p.roles?.includes('authz')
    );
    if (unguarded.length > 0)
      this.logger.warn(
        `Authentication is restricted to ${prefixes.join(', ')}, so these ` +
          `routes are served without authentication` +
          (judged ? ' nor authorization' : '') +
          `: ${unguarded.sort().join(', ')}`
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
    ): void => {
      let statusCode =
        'statusCode' in err ? (err as { statusCode: number }).statusCode : 500;

      // Recognise the authz-forbidden marker embedded by authz plugins so a
      // 403 survives being wrapped into a plain Error by downstream callers
      // (which otherwise drops `statusCode` and surfaces as a 500).
      let clientMessage = err.message;
      if (statusCode === 500 && /\[authz-forbidden\]/.test(err.message)) {
        statusCode = 403;
        clientMessage = AUTHZ_REFUSED;
      } else if (
        statusCode === 403 &&
        /\[authz-forbidden\]/.test(err.message)
      ) {
        clientMessage = AUTHZ_REFUSED;
      }

      // Client error (4xx) - log as warning and return error message
      if (statusCode >= 400 && statusCode < 500) {
        this.logger.warn(
          `Client error ${statusCode} in request ${req.method} ${req.path}: ${clientMessage}`
        );
        // `res.json` answers the response object; the middleware answers
        // nothing, which is what lets the signature say so.
        if (!res.headersSent)
          res.status(statusCode).json(errorBody(err, clientMessage));
        return;
      }

      // Server error (5xx): logged, named in the answer only under --debug
      this.logger.error(
        `Server error ${statusCode} in request ${req.method} ${req.path}: ${err.message}`,
        {
          stack: err.stack,
          url: req.url,
          method: req.method,
        }
      );

      if (!res.headersSent)
        res.status(statusCode).json(serverErrorBody(err, this.config.debug));
    };

    this.app.use(this._errorMiddleware);
    this._errorMiddlewareSetup = true;
  }

  /**
   * Exit on a failure nothing caught: an exception leaves the process in a
   * state nobody knows, so it shuts down as cleanly as it can, within the
   * shutdown budget, and exits with 1 for its supervisor to start it again.
   * A rejection nothing handled is logged and counted; the request that
   * owned it has been answered or will time out.
   *
   * For the binary; a host assembling the server decides for itself, and
   * without it Node's own action applies.
   */
  exitOnCrash(): void {
    process.on('uncaughtException', (err: Error) => {
      this.logger.error(`Uncaught exception: ${err.message}`, {
        stack: err.stack,
      });
      // Referenced: an empty event loop must not end the process with 0
      setTimeout(() => process.exit(1), this.config.shutdown_timeout as number);
      void this.shutdown().finally(() => process.exit(1));
    });
    process.on('unhandledRejection', (reason: unknown) => {
      this.life.unhandledRejections++;
      unhandledRejections.inc();
      this.logger.error(
        `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        { stack: reason instanceof Error ? reason.stack : undefined }
      );
    });
  }

  run(): Promise<void> {
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

  /**
   * Stop serving: the readiness answers 503, the listening socket closes,
   * what is in flight finishes, then every plugin's `close()` runs and the
   * directory connections are closed, the whole within `--shutdown-timeout`
   * whatever hangs. Called once; a second call waits for the first.
   *
   * @returns when everything let go, resolved whatever failed on the way
   */
  shutdown(): Promise<void> {
    this.life.shutdown ??= this.letGo();
    return this.life.shutdown;
  }

  private async letGo(): Promise<void> {
    const budget = this.config.shutdown_timeout as number;
    const started = Date.now();
    // The last seconds are for the plugins and the directory to let go
    const drain = Math.max(1000, budget - 5000);
    this.logger.notice(`Shutting down, ${drain} ms for what is in flight`);
    const server = this.server;
    if (server) {
      // Idle keep-alive connections close now; the others with the response
      // they carry, which closes them, or when the drain is spent
      const closed = new Promise<void>(resolve =>
        server.close(() => resolve())
      );
      server.closeIdleConnections();
      for (const res of this.inFlight)
        if (!res.headersSent) res.setHeader('Connection', 'close');
      await DM.within(closed, drain);
      server.closeAllConnections();
    }
    const closing = new Map<string, Promise<void>>();
    for (const [name, plugin] of Object.entries(this.loadedPlugins)) {
      closing.set(
        name,
        Promise.resolve()
          .then(() => plugin.close?.())
          .catch((err: unknown) => {
            this.logger.warn(
              `${name}: close failed: ${err instanceof Error ? err.message : String(err)}`
            );
          })
          .finally(() => closing.delete(name))
      );
    }
    const letGo = Promise.all(closing.values()).then(() =>
      this.ldap.close().catch(() => undefined)
    );
    // A second short of the budget: the crash and signal timers end the
    // process at the budget, and what gave up is logged before they do
    const left = Math.max(1000, budget - (Date.now() - started) - 1000);
    if (!(await DM.within(letGo, left))) {
      this.logger.warn(
        `Shut down with a close still pending: ${[...closing.keys()].join(', ') || 'the directory connections'}`
      );
      // Closed whatever plugin still holds the others back
      void this.ldap.close().catch(() => undefined);
    }
    this.logger.notice('Shut down');
  }

  /** @returns whether `done` settled before `ms` passed */
  private static async within(
    done: Promise<void>,
    ms: number
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spent = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([done.then(() => true), spent]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Shut down on SIGTERM and SIGINT, then let the signal end the process.
   * For the binary; a host assembling the server decides for itself.
   */
  shutdownOnSignals(): void {
    shutdownTimeout.ms = this.config.shutdown_timeout as number;
    registerProcessShutdown(() => this.shutdown());
  }

  /**
   * The module part of a `--plugin` entry.
   *
   * An entry is `module[:name[:{overrides}]]`, and the module is what
   * decides where it loads from — and, since the priority list names
   * modules, which pass loads it. One rule, used by the loader and by that
   * list, rather than two that can drift.
   *
   * @param entry a `--plugin` value
   * @returns the module it names
   */
  private static moduleOf(entry: string): string {
    const colon = entry.indexOf(':');
    return colon === -1 ? entry : entry.substring(0, colon);
  }

  /**
   * Where a module name resolves, as `import()` would resolve it.
   *
   * `core/x` is this build's `plugins/x.js`, and a relative path is relative
   * to this file — so the two spellings of one plugin compare equal, which
   * is what lets the priority list recognise a plugin configured by path.
   *
   * @param module module part of a `--plugin` entry
   * @returns an absolute path for what can be resolved, the name itself
   *          otherwise (a package, resolved by node)
   */
  private resolveModule(module: string): string {
    if (module.startsWith('core/'))
      return module
        .replace(
          'core/',
          join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins') + '/'
        )
        .replace(/$/, '.js');
    if (module.startsWith('.'))
      return fileURLToPath(new URL(module, import.meta.url));
    return module;
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
    const key = overrides
      ? undefined
      : `${this.resolveModule(pluginName)}\0${name ?? ''}`;
    const pending = key === undefined ? undefined : this.pluginLoads.get(key);
    if (pending) {
      this.logger.debug(`Plugin ${pluginName} already loaded, skipping`);
      return pending;
    }
    const load = this.importPlugin(pluginName, name, overrides);
    if (key !== undefined) {
      this.pluginLoads.set(key, load);
      // A failed load is not worth remembering: a later one tries again
      const forget = (): void => {
        if (this.pluginLoads.get(key) === load) this.pluginLoads.delete(key);
      };
      load.then(ok => ok || forget(), forget);
    }
    return load;
  }

  private importPlugin(
    pluginName: string,
    name: string | undefined,
    overrides: Config | undefined
  ): Promise<boolean> {
    this.logger.debug(`Loading plugin ${pluginName}`);
    // `core/x` is rewritten; anything else is handed to `import()` as
    // written. `resolveModule` would answer the same file for a relative
    // path, but as an absolute one — and a resolver that maps `.js` to a
    // `.ts` beside it (tsx, under the test runner) does that for a
    // specifier, not for a path. Comparing modules is its job; importing
    // them is not.
    if (pluginName.startsWith('core/'))
      pluginName = this.resolveModule(pluginName);
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

  /**
   * Refuse a plugin whose arrival makes the authorization composition
   * ambiguous, before any of it is registered.
   *
   * The configuration's plugins are checked together once loaded; a plugin
   * registered afterwards — the way an embedding host assembles a server —
   * would otherwise never be, and two branch models registered by hand would
   * compose as the AND the startup check exists to refuse. Checked before
   * its routes and hooks exist, so a refused plugin leaves nothing behind.
   *
   * @param obj the plugin about to be registered
   * @throws Error when the composition would be refused at startup
   */
  private async admitToComposition(obj: DmPlugin): Promise<void> {
    this.loadedPlugins[obj.name] = obj;
    try {
      await assertAuthzComposition(this, obj);
    } finally {
      delete this.loadedPlugins[obj.name];
    }
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
    if (this._composed) await this.admitToComposition(obj);
    if (obj.api) {
      this.mountAuthDispatcher(obj);
      this.logger.debug(`Plugin ${obj.name} has API, registering it`);
      await obj.api(this.app);
      // If error middleware was already setup, re-setup it to ensure it stays at the end
      if (this._errorMiddlewareSetup) {
        this.setupErrorMiddleware();
      }
    }
    if (obj.hooks) {
      for (const hookName in obj.hooks) {
        this.logger.debug(
          `Plugin ${obj.name} has hook ${hookName}, registering it`
        );
        const hook = obj.hooks[hookName as keyof Hooks];
        // A map spread from a base's may hold an unset optional hook
        if (hook === undefined) continue;
        if (typeof hook !== 'function') {
          throw new Error(`Plugin ${obj.name}: hook ${hookName} is invalid`);
        }
        const name = hookName as keyof Hooks;
        recordHookOwner(hook, obj.name, hookName);
        if (obj.roles?.includes('authz') && AUTHZ_FIRST_HOOKS.includes(name)) {
          // After the authorization hooks already there, before the rest
          const others = this.hookBus.subscribers(name) as HookFn[];
          const at = others.findIndex(other => !this.authzHooks.has(other));
          this.hookBus.insert(name, hook, at < 0 ? others.length : at);
          this.authzHooks.add(hook);
        } else this.hookBus.subscribe(name, hook);
      }
    }
    this.loadedPlugins[obj.name] = obj;
    return true;
  }
}
