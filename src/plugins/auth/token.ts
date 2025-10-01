/**
 * @module plugins/auth/token
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Token-based authentication plugin
 * @group Plugins
 */
import type { Request, Response } from 'express';

import { unauthorized } from '../../lib/expressFormatedResponses';
import AuthBase from '../../lib/auth/base';

export default class AuthToken extends AuthBase {
  name = 'authToken';

  authMethod(req: Request, res: Response, next: () => void): void {
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
  }
}
