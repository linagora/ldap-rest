/**
 * @module plugins/auth/llng
 * @group Plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Lemonldap::NG authentication plugin
 * This plugin enables authentication and authorization using Lemonldap::NG.
 */
import * as llng from 'lemonldap-ng-handler';
import type { Request, Response } from 'express';

import AuthBase from '../../lib/auth/base';

export default class AuthLLNG extends AuthBase {
  name = 'authLemonldapNg';

  authMethod(req: Request, res: Response, next: () => void): void {
    llng.run(req, res, next);
  }
}
