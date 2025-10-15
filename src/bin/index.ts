/**
 * @packageDocumentation mini-dm
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

import { parseConfig } from '../lib/parseConfig';
import configArgs, { type Config } from '../config/args';
import type { Hooks } from '../hooks';
import ldapActions from '../lib/ldapActions';
import type DmPlugin from '../abstract/plugin';
import { buildLogger } from '../logger/winston';
import { setLogger } from '../lib/expressFormatedResponses';
import pluginPriority from '../plugins/priority.json';

export type { Config };

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

      // Load priority plugins first
      for (const p of pluginPriority) {
        if (regularPlugins.includes(p)) {
          regularPlugins = regularPlugins.filter(pl => pl !== p);
          promises.push(this.loadPlugin(p));
        }
      }

      // Load remaining plugins
      for (const pluginName of regularPlugins) {
        promises.push(this.loadPlugin(pluginName));
      }

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
          .then(() => resolve())
          .catch(err => reject(new Error('Error loading plugins: ' + err)));
      } else {
        resolve();
      }
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
            obj = new pluginModule({ ...this, config: newConfig } as DM);
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
      this.logger.info(`Plugin ${pluginName} already loaded as ${obj.name}`);
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
      this.logger.debug(`Plugin ${obj.name} has API, registering it`);
      await obj.api(this.app);
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
