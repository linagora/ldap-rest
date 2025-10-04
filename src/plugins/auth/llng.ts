/**
 * @module plugins/auth/llng
 * @group Plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Lemonldap::NG authentication plugin
 * This plugin enables authentication and authorization using Lemonldap::NG.
 */
import * as llng from 'lemonldap-ng-handler';
import type { Response } from 'express';

import AuthBase, { DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

export default class AuthLLNG extends AuthBase {
  name = 'authLemonldapNg';
  roles: Role[] = ['auth'] as const;

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    llng.run(req, res, () => {
      req.user = req.headers['Lm-Remote-User'] as string;
      next();
    });
  }
}
