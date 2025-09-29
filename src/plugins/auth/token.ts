/**
 * @module plugins/auth/token
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Token-based authentication plugin
 * @group Plugins
 */
import type { Express } from 'express';

import DmPlugin from '../../abstract/plugin';
import { unauthorized } from '../../lib/expressFormatedResponses';

export default class AuthToken extends DmPlugin {
  name = 'authToken';

  api(app: Express): void {
    app.use((req, res, next) => {
      let token = req.headers['authorization'];

      if (!token || !/^Bearer .+/.test(token)) {
        this.logger.warn('Missing or invalid Authorization header');
        return unauthorized(res);
      }
      token = token.split(' ')[1];
      if (!(this.config.auth_token as string[]).includes(token)) {
        this.logger.warn(`Unauthorized token: ${token}`);
        return unauthorized(res);
      }
      // @ts-expect-error new property
      res.user =
        'token number ' + (this.config.auth_token as string[]).indexOf(token);
      next();
    });
  }
}
