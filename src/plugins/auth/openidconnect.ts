import type { Express, Response } from 'express';
import { auth, ConfigParams } from 'express-openid-connect';

import { DmRequest } from '../../lib/auth/base';
import DmPlugin, { type Role } from '../../abstract/plugin';
import { launchHooks, launchHooksChained } from '../../lib/utils';
import { serverError } from '../../lib/expressFormatedResponses';
import { DM } from '../../bin';
import type { OidcLogoutToken, OidcSessionClaims } from '../../hooks';

export default class OpenIDConnect extends DmPlugin {
  name = 'openidconnect';
  roles: Role[] = ['auth'] as const;

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
      // Back-Channel Logout, handed to whoever subscribed. This plugin knows
      // how to receive a logout token and how to ask whether the session in
      // front of it is still alive; where that answer is kept is a plugin of
      // its own. Both hooks are supplied rather than a store, which is what
      // lets the session stay in the cookie: only what is dead is recorded.
      backchannelLogout: {
        onLogoutToken: async (decoded: object): Promise<void> => {
          if (!this.server.hooks.oidclogouttoken) {
            // The route exists as soon as this plugin does, so without a
            // subscriber the provider is told the logout succeeded and
            // nothing acts on it. Say so rather than drop it in silence.
            this.logger.warn(
              'openidconnect: a logout token arrived but no Back-Channel ' +
                'Logout plugin is loaded, so nothing records it'
            );
            return;
          }
          await launchHooks(
            this.server.hooks.oidclogouttoken,
            decoded as OidcLogoutToken
          );
        },
        isLoggedOut: async (req: DmRequest): Promise<boolean> => {
          if (!this.server.hooks.oidcsessionvalid) return false;
          const claims = (
            req as unknown as { oidc: { idTokenClaims: OidcSessionClaims } }
          ).oidc.idTokenClaims;
          const [, valid] = await launchHooksChained(
            this.server.hooks.oidcsessionvalid,
            [claims, true]
          );
          return !valid;
        },
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
