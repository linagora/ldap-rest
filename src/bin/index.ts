/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import express from 'express';

import { parseConfig } from '../lib/parseConfig';
import configArgs from '../config/args';

const config = parseConfig(configArgs);

const app = express();

// If authentication is native lemonldap-ng, then load and use its middleware
if (config.auth == 'llng') {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: dynamic import (overriden into rollup config)
  await import('lemonldap-ng-handler')
    .then(llng => {
      void llng.init({
        configStorage: {
          confFile: config.llng_ini as string,
        },
        type: undefined,
      });
      app.use(llng.run);
    })
    .catch(err => {
      console.error('Failed to load lemonldap-ng-handler:', err);
    });
}

if (config.plugin) {
  for (let pluginName of config.plugin) {
    if (pluginName.startsWith('core/')) {
      pluginName = pluginName
        .replace('core/', '../plugins/')
        .replace(/$/, '.js');
    }
    await import(pluginName)
      .then(pluginModule => {
        if (pluginModule && pluginModule.default) {
          pluginModule.default(app);
        } else if (pluginModule) {
          pluginModule(app);
        } else {
          console.error(`Plugin ${pluginName} has no default export`);
          process.exit(1);
        }
      })
      .catch(err => {
        console.error(`Failed to load plugin ${pluginName}:`, err);
        process.exit(1);
      });
  }
}

app.listen(config.port, () => {
  return console.debug(`Listening on port ${config.port}`);
});
