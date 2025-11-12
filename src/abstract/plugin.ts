/**
 * Abstract class for plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express } from 'express';
import type winston from 'winston';

import type { Config, DM } from '../bin';
import type { Hooks, MaybePromise } from '../hooks';

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
}
