/**
 * Abstract class for plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express } from 'express';
import type winston from 'winston';

import type { Config, DM } from '../bin';
import type { Hooks, MaybePromise } from '../hooks';
import type HookBus from '../lib/hookBus';
import type { HealthStatus } from '../lib/health';
import {
  providedService,
  type ServiceProvider,
  type ServiceToken,
} from '../lib/services';
import { timedOutbound } from '../lib/metrics';
import {
  neverReturnAttributes,
  withoutAttributes,
  type Schema,
} from '../config/schema';
import { readOptions, type OptionsOf, type OptionSet } from '../config/options';
import configArgs from '../config/args';

const parsedOptionKeys = new Set(
  configArgs.map(entry => entry[0].replace(/^--?/, '').replace(/-/g, '_'))
);

export {
  asyncHandler,
  escapeDnValue,
  unescapeDnValue,
  escapeLdapFilter,
  validateDnValue,
} from '../lib/utils';
export { defineRoute, registeredRoutes } from '../lib/route';
export { serviceToken } from '../lib/services';
export type { ServiceProvider, ServiceToken } from '../lib/services';
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

export type { HealthStatus };

export type Role =
  | 'auth'
  | 'authz'
  | 'protect'
  | 'api'
  | 'logging'
  | 'demo'
  | 'consistency'
  | 'configurable';

export default abstract class DmPlugin {
  /** Options this plugin declares, see `docs/plugin-development/options.md` */
  static optionDefinitions: OptionSet = {};

  /**
   * Properties inherited from parent (DM)
   */

  /* parent object (DM server) */
  server: DM;
  /* Global configuration */
  config: Config;
  /* The server's hooks, typed */
  hookBus: HookBus;
  /* Logger */
  logger: winston.Logger;

  /* The hooks `registerPlugin` registered for this plugin */
  registeredHooks: Hooks = {};

  /**
   * Interfaces
   */

  /* Hooks to register */
  hooks?: Hooks;

  /* Needed plugins */
  dependencies?: Record<string, string>;

  /**
   * Services this plugin provides, each bound to its token. A consumer
   * reaches them with `service(token)`, see
   * `docs/plugin-development/services.md`.
   */
  provides?: ServiceProvider<unknown>[];

  /* Plugin roles for categorization */
  roles?: Role[] | undefined;

  /**
   * Operational attributes this plugin follows through `onLdapEntryChange`,
   * e.g. `pwdAccountLockedTime`. A search returns none unless asked by name,
   * so `core/ldap/onChange` requests these beside `*`.
   */
  followedOperationalAttributes?: string[];

  /* Function to register API */
  api?(app: Express): MaybePromise<void>;

  /* Function to provide configuration for config API */
  getConfigApiData?(): MaybePromise<Record<string, unknown> | undefined>;

  /** Key of that configuration under `features`; the instance name otherwise */
  configApiKey?: string;

  /**
   * Called once every plugin is loaded, before the first request.
   *
   * A constructor and `api()` run while the others are still loading, so
   * neither can see what a configuration amounts to as a whole — which
   * authenticators are loaded beside this one, whether two plugins claim the
   * same thing. This is where a plugin says, once, that a combination is
   * ambiguous: the check that catches a mispairing before a request does
   * rather than after.
   */
  afterLoad?(): void;

  /**
   * Called once every plugin is loaded, before `afterLoad`: refuse a
   * configuration this plugin cannot serve.
   *
   * `afterLoad` is an opinion, logged and served anyway. Throwing here, or
   * rejecting, stops the server from starting — for a setting that would
   * otherwise make the plugin answer on behalf of something that is not
   * there, or a service it cannot work without.
   */
  assertComposition?(): MaybePromise<void>;

  /**
   * Asked by `GET /readyz`: `degraded` when a resource this plugin depends
   * on does not answer while the server still serves. Only the directory
   * makes the server not ready, see `docs/usage/operations.md`.
   */
  health?(): MaybePromise<HealthStatus>;

  /**
   * Called once by the shutdown, after the server stopped serving: let go
   * of what this plugin holds, a connection, a timer, a queue. See
   * `docs/usage/operations.md#shutdown`.
   */
  close?(): MaybePromise<void>;

  /* Uniq name of this plugin */
  abstract name: string;

  /**
   * Call another service: `fetch`, timed into the outbound metrics under
   * this plugin's name, see `docs/usage/operations.md#metrics`.
   */
  protected fetch(
    url: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ): Promise<Response> {
    return timedOutbound(this.name, () => fetch(url, init));
  }

  /**
   * Constructor
   * @param server DM object
   */
  constructor(server: DM) {
    this.server = server;
    this.config = server.config;
    this.hookBus = server.hookBus;
    this.logger = server.logger;
    this.registeredHooks = server.hooks;
    // Check the declared options before the plugin reads one
    this.options((this.constructor as typeof DmPlugin).optionDefinitions);
  }

  /** Values of the options this plugin declares, read and checked */
  options<T extends OptionSet>(definitions: T): OptionsOf<T> {
    const declared = (this.constructor as typeof DmPlugin).optionDefinitions;
    if (definitions !== declared)
      throw new Error(
        `${this.constructor.name}: options() takes the definitions the ` +
          'plugin declares'
      );
    return readOptions(declared, this.config, parsedOptionKeys, message =>
      this.logger.warn(message)
    ) as OptionsOf<T>;
  }

  /**
   * Uniq ID, to be used when calling hooks
   *
   * Example: plugin/ldap/groups has 2 events for some operations,
   * it uses opNumber to permit to plugin to link the 2 calls
   *
   * @returns uniq operation number
   */
  opNumber(): number {
    return this.server.operationSequence++;
  }

  /**
   * Leave out of data about to be sent every attribute a loaded schema marks
   * `neverReturn`.
   *
   * A flat entity hides its own attributes, but an organization's subnodes are
   * users, groups, positions…, each described by another plugin's schema: an
   * answer mixing entities has to honour all of them, or `/users/<uid>` hides
   * a password hash that `/organizations/<org>/subnodes` hands out.
   *
   * @param data an entry, a list of entries, or entries keyed by identifier
   * @returns the same shape, without the hidden attributes
   */
  protected hideNeverReturn<T>(data: T): T {
    const schemas: (Schema | undefined)[] = [];
    const isSchema = (value: unknown): value is Schema =>
      typeof (value as Schema | undefined)?.attributes === 'object';
    for (const plugin of Object.values(this.server.loadedPlugins)) {
      const candidate = plugin as unknown as {
        schema?: unknown;
        instances?: { schema?: unknown }[];
      };
      if (isSchema(candidate.schema)) schemas.push(candidate.schema);
      if (Array.isArray(candidate.instances))
        for (const instance of candidate.instances)
          if (isSchema(instance.schema)) schemas.push(instance.schema);
    }
    const hidden = neverReturnAttributes(schemas);
    if (hidden.size === 0 || !data || typeof data !== 'object') return data;
    // Only a plain object is an entry: projecting an array as one turns it
    // into an object keyed by index.
    const project = (entry: unknown): unknown =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? withoutAttributes(entry, hidden)
        : entry;
    if (Array.isArray(data)) return (data as unknown[]).map(project) as T;
    // An entry carries its dn; a keyed list carries entries as values
    if ('dn' in data) return withoutAttributes(data, hidden);
    return Object.fromEntries(
      Object.entries(data).map(([key, entry]) => [key, project(entry)])
    ) as T;
  }

  /** Names already warned about by requirePlugin, so each warns at most once. */
  private missingPluginsWarned?: Set<string>;

  /** Services already warned about by service(), so each warns at most once. */
  private missingServicesWarned?: Set<ServiceToken<unknown>>;

  /**
   * Reach a service another plugin provides. Declare the providing plugin in
   * `dependencies` so it registers first. Returns null and logs a single
   * warning when nothing provides it, so the consumer skips its feature
   * rather than throwing.
   *
   * @param token the service wanted
   * @returns the provided instance, or null
   */
  protected service<T>(token: ServiceToken<T>): T | null {
    const provided = providedService(this.server.services, token);
    if (provided !== undefined) return provided;
    if (!this.missingServicesWarned)
      this.missingServicesWarned = new Set<ServiceToken<unknown>>();
    if (!this.missingServicesWarned.has(token)) {
      this.missingServicesWarned.add(token);
      this.logger.warn(
        `${this.name}: service '${token.name}' is not provided — its features will be skipped`
      );
    }
    return null;
  }

  /**
   * Resolve a sibling plugin by its registry name (the value of its `name`
   * property). Declare it in `dependencies` so it loads first. Returns null and
   * logs a single warning if it is absent, letting the caller no-op cleanly
   * rather than throw. Use this instead of indexing `server.loadedPlugins`
   * directly so consumers share one typed, log-once lookup.
   */
  protected requirePlugin<T extends DmPlugin>(name: string): T | null {
    const plugin = this.server.loadedPlugins[name] as T | undefined;
    if (plugin) return plugin;
    if (!this.missingPluginsWarned) this.missingPluginsWarned = new Set();
    if (!this.missingPluginsWarned.has(name)) {
      this.missingPluginsWarned.add(name);
      this.logger.warn(
        `${this.name}: required plugin '${name}' is not loaded — its features will be skipped`
      );
    }
    return null;
  }
}
