/**
 * @plugin core/auth/llng
 * @description Lemonldap::NG authentication plugin
 * @author Xavier Guimard <xguimard@linagora.com>
 * This plugin enables authentication and authorization using Lemonldap::NG.
 */
import * as llng from 'lemonldap-ng-handler';
import type { Express } from 'express';

import DmPlugin from '../../abstract/plugin';

export default class AuthLLNG extends DmPlugin {
  name = 'authLemonldapNg';

  async api(app: Express): Promise<void> {
    await llng.init({
      configStorage: {
        confFile: this.config.llng_ini as string,
      },
      type: undefined,
    });
    app.use(llng.run);
  }
}
