/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import express from 'express';

import { type Config } from './lib/parseConfig';
import { parseConfig } from './lib/parseConfig';

const ConfigTemplate: Config = [
  {
    cliArg: '--port',
    envVar: 'DM_PORT',
    defaultValue: 8081,
    isInteger: true,
  },
  {
    cliArg: '--auth',
    envVar: 'DM_AUTH',
    defaultValue: '',
  },
  {
    cliArg: '--llng-ini',
    envVar: 'DM_LLNG_INI',
    defaultValue: '/etc/lemonldap-ng/lemonldap-ng.ini',
  },
];

const config = parseConfig(ConfigTemplate);

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
