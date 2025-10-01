import type { Express, Response } from 'express';
import { auth, ConfigParams } from 'express-openid-connect';

import { DmRequest } from '../../lib/auth/base';
import DmPlugin from '../../abstract/plugin';
import { launchHooksChained } from '../../lib/utils';
import { serverError } from '../../lib/expressFormatedResponses';
import { DM } from '../../bin';

export default class OpenIDConnect extends DmPlugin {
  name = 'openidconnect';

  constructor(server: DM) {
    super(server);
    for (const p of [
      'oidc_server',
      'oidc_client_id',
      'oidc_client_secret',
      'base_url',
    ]) {
      if (!this.config[p]) throw new Error(`Missing config parameter ${p}`);
    }
  }

  api(app: Express): void {
    const config: ConfigParams = {
      authRequired: true,
      issuerBaseURL: this.config.oidc_server,
      clientID: this.config.oidc_client_id,
      secret: this.config.oidc_client_secret as string,
      baseURL: this.config.base_url as string,
      clientSecret: this.config.oidc_client_secret as string,
      authorizationParams: {
        response_type: 'code',
        scope: 'openid profile email',
      },
    };
    app.use(async (req, res, next) => {
      try {
        [req, res] = await launchHooksChained(this.server.hooks.beforeAuth, [
          req,
          res,
        ]);
        next();
      } catch (err) {
        return serverError(res, err as Error);
      }
    });
    app.use(auth(config));
    app.use(async (req, res, next) => {
      try {
        if (this.hooks?.onAuth) {
          [req, res] = await launchHooksChained(this.server.hooks.afterAuth, [
            req,
            res,
          ]);
        }
        // @ts-expect-error request is augmented by express-openid-connect
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        req.user = req.oidc.user.sub;
        next();
      } catch (err) {
        serverError(res, err as Error);
      }
    });
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    auth({
      issuerBaseURL: process.env.ISSUER_BASE_URL,
      clientID: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      baseURL: process.env.BASE_URL,
      authorizationParams: {
        response_type: 'code',
        scope: 'openid email profile',
      },
    })(req, res, next);
  }
}
