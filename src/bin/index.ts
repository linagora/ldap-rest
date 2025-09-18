/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import express from 'express';

import { parseConfig } from '../lib/parseConfig';
import configArgs, { type Config } from '../config/args';
import ldap from '../lib/ldapActions';

export { ldap };
export type { Config };

//export const build = () => {

export class DM {
  app: express.Express;
  config: Config;
  ready: Promise<void>;
  server?: import('http').Server;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  hooks: { [key: string]: Function[] } = {};

  constructor() {
    this.config = parseConfig(configArgs);

    this.app = express();
    const promises: Promise<void>[] = [];

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
        console.debug('Loading plugin', pluginName);
        promises.push(
          new Promise<void>((resolve, reject) => {
            import(pluginName)
              .then(pluginModule => {
                if (pluginModule && pluginModule.default) {
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  pluginModule = pluginModule.default;
                }
                let validPlugin = false;
                if (pluginModule.api) {
                  validPlugin = true;
                  pluginModule.api(this.app, this);
                }
                if (pluginModule.hooks) {
                  validPlugin = true;
                  for (const hookName in pluginModule.hooks) {
                    if (!this.hooks[hookName]) {
                      this.hooks[hookName] = [];
                    }
                    this.hooks[hookName].push(pluginModule.hooks[hookName]);
                  }
                }
                if (validPlugin) {
                  console.debug(`Plugin ${pluginName} loaded`);
                  resolve();
                } else {
                  reject(
                    new Error(`Plugin ${pluginName} has no default export`)
                  );
                }
              })
              .catch(err => {
                reject(
                  new Error(`Failed to load plugin ${pluginName}: ${err}`)
                );
              });
          })
        );
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
}
