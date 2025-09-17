/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import express from 'express';

import { parseConfig } from './lib/parseConfig';
import configArgs from './config/args';

const config = parseConfig(configArgs);

const app = express();

// If authentication is native lemonldap-ng, then load and use its middleware
if (config.auth == 'llng') {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: dynamic import (overriden into rollup config)
  await import('lemonldap-ng-handler').then(llng => {
    llng.init({
      configStorage: {
        confFile: config.llng_ini as string,
      },
      type: undefined,
    });
    app.use(llng.run);
  });
}

app.listen(config.port, () => {
  return console.debug(`Listening on port ${config.port}`);
});
