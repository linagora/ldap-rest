/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import express from 'express';
import bodyParser from 'body-parser';

import { parseConfig } from '../lib/parseConfig';
import configArgs, { type Config } from '../config/args';
import { Hooks } from '../hooks';
import ldapActions from '../lib/ldapActions';

export type { Config };

//export const build = () => {

export class DM {
  app: express.Express;
  config: Config;
  ready: Promise<void>;
  server?: import('http').Server;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  hooks: { [K in keyof Hooks]?: Function[] } = {};
  loadedPlugins: { [key: string]: object[] } = {};
  ldap: ldapActions;
  operationSequence: number;

  constructor() {
    this.config = parseConfig(configArgs);

    this.app = express();
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({ extended: true }));
    this.ldap = new ldapActions(this);
    this.operationSequence = 0;
    const promises: Promise<void | boolean>[] = [];

    // If authentication is native lemonldap-ng, then load and use its middleware
    if (this.config.auth == 'llng') {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: dynamic import (overriden into rollup config)
      promises.push(
        import('lemonldap-ng-handler')
          .then(llng => {
            void llng.init({
              configStorage: {
                confFile: this.config.llng_ini as string,
              },
              type: undefined,
            });
            this.app.use(llng.run);
          })
          .catch(err => {
            console.error('Failed to load lemonldap-ng-handler:', err);
          })
      );
    }

    if (this.config.plugin) {
      for (let pluginName of this.config.plugin) {
        if (pluginName.startsWith('core/')) {
          pluginName = pluginName
            .replace(
              'core/',
              process.env.NODE_ENV === 'test'
                ? '../../dist/plugins/'
                : '../plugins/'
            )
            .replace(/$/, '.js');
        }
        promises.push(this.loadPlugin(pluginName));
      }
    }
    this.ready = new Promise((resolve, reject) => {
      if (promises.length > 0) {
        Promise.all(promises)
          .then(() => {
            resolve();
          })
          .catch(err => {
            reject(new Error('Error loading plugins: ' + err));
          });
      } else {
        resolve();
      }
    });
  }

  run(): Promise<void> {
    return new Promise(resolve => {
      this.server = this.app.listen(this.config.port, () => {
        console.debug(`Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.app.removeAllListeners();
    this.server?.close();
    console.debug('Server stopped');
  }

  loadPlugin(pluginName: string): Promise<boolean> {
    console.debug('Loading plugin', pluginName);
    return new Promise<boolean>((resolve, reject) => {
      import(pluginName)
        .then(async pluginModule => {
          if (pluginModule && pluginModule.default) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            pluginModule = pluginModule.default;
          }
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const obj = new pluginModule(this);
          if (!obj) return reject(new Error(`Unable to load ${pluginName}`));
          if (!obj.name) obj.name = pluginName;
          if (this.loadedPlugins[obj.name]) {
            console.info(`Plugin ${pluginName} already loaded as ${obj.name}`);
            return resolve(false);
          }
          if (obj.dependencies) {
            for (const dependency in obj.dependencies) {
              if (!this.loadedPlugins[dependency]) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                await this.loadPlugin(obj.dependencies[dependency]);
              }
            }
          }
          if (obj.api) {
            obj.api(this.app, this);
          }
          if (obj.hooks as Hooks) {
            for (const hookName in pluginModule.hooks as Hooks) {
              const hook = (obj.hooks as Hooks)[hookName as keyof Hooks];
              if (!this.hooks[hookName as keyof Hooks]) {
                this.hooks[hookName as keyof Hooks] = [];
              }
              if (hook && typeof hook === 'function') {
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore: object is defined
                this.hooks[hookName as keyof Hooks].push(hook);
              } else {
                return reject(
                  new Error(`Plugin ${pluginName}: hook ${hookName} is invalid`)
                );
              }
            }
          }

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          this.loadedPlugins[obj.name] = obj;
          resolve(true);
        })
        .catch(err => {
          reject(new Error(`Failed to load plugin ${pluginName}: ${err}`));
        });
    });
  }
}
