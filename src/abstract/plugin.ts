/**
 * Abstract class for plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express } from 'express';
import type winston from 'winston';

import type { Config, DM } from '../bin';
import type { Hooks, MaybePromise } from '../hooks';
import {
  neverReturnAttributes,
  withoutAttributes,
  type Schema,
} from '../config/schema';

export {
  asyncHandler,
  escapeDnValue,
  unescapeDnValue,
  escapeLdapFilter,
  validateDnValue,
} from '../lib/utils';
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
  /**
   * Properties inherited from parent (DM)
   */

  /* parent object (DM server) */
  server: DM;
  /* Global configuration */
  config: Config;
  /* Logger */
  logger: winston.Logger;

  /* Hooks registered into DM */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  registeredHooks: { [K in keyof Hooks]?: Function[] } = {};

  /**
   * Interfaces
   */

  /* Hooks to register */
  hooks?: Hooks;

  /* Needed plugins */
  dependencies?: Record<string, string>;

  /* Plugin roles for categorization */
  roles?: Role[] | undefined;

  /* Function to register API */
  api?(app: Express): MaybePromise<void>;

  /* Function to provide configuration for config API */
  getConfigApiData?(): Record<string, unknown> | undefined;

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
   * `afterLoad` is an opinion, logged and served anyway. Throwing here stops
   * the server from starting — for a setting that would otherwise make the
   * plugin answer on behalf of something that is not there.
   */
  assertComposition?(): void;

  /* Uniq name of this plugin */
  abstract name: string;

  /**
   * Constructor
   * @param server DM object
   */
  constructor(server: DM) {
    this.server = server;
    this.config = server.config;
    this.logger = server.logger;
    this.registeredHooks = server.hooks;
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
