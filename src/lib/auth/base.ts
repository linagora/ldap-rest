import type { Express, Request, Response } from 'express';

// eslint-disable-next-line import/order
import DmPlugin from '../../abstract/plugin';

import { serverError } from '../../lib/expressFormatedResponses';
import { launchHooksChained } from '../../lib/utils';

export default abstract class AuthBase extends DmPlugin {
  abstract authMethod(req: Request, res: Response, next: () => void): void;
  api(app: Express): void {
    app.use(async (req, res, next) => {
      try {
        [req, res] = await launchHooksChained(this.server.hooks.beforeAuth, [
          req,
          res,
        ]);
      } catch (err) {
        return serverError(res, err as Error);
      }
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      this.authMethod(req, res, async (): Promise<void> => {
        try {
          if (this.hooks?.onAuth) {
            [req, res] = await launchHooksChained(this.server.hooks.afterAuth, [
              req,
              res,
            ]);
          }
          next();
        } catch (err) {
          serverError(res, err as Error);
        }
      });
    });
  }
}
