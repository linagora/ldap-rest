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

  /**
   * What is handed to `express-openid-connect`.
   *
   * Built apart from `api` so it can be looked at: leaving `onLogin` out of
   * `backchannelLogout` made the library run its own, which reaches for a
   * store nothing configured here and threw on every callback — a 500 on
   * every login, with the session cookie already set.
   */
  buildConfig(): ConfigParams {
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
          // Deliberately not `launchHooks`: its contract is to report and
          // swallow, so a store that could not write would leave the
          // provider told 204 about a logout nothing kept. Here the failure
          // has to reach the library, which answers 400 and lets the
          // provider retry — so the subscribers are walked in this plugin's
          // own terms.
          const subscribers = this.server.hooks.oidclogouttoken as unknown as ((
            token: OidcLogoutToken
          ) => Promise<void> | void)[];
          // Every backend gets the token, and the first failure is still
          // raised. Stopping at it would cost the healthy stores their
          // record — a session the provider considers closed would keep
          // working against the one that would have killed it, which is the
          // fail-open arriving through the store that works.
          let firstError: Error | undefined;
          for (const subscriber of subscribers ?? []) {
            if (!subscriber) continue;
            try {
              await subscriber(decoded as OidcLogoutToken);
            } catch (err) {
              firstError ??=
                err instanceof Error ? err : new Error(String(err));
            }
          }
          if (firstError) throw firstError;
        },
        // Supplying this is not optional. Left out, the library runs its own,
        // which reaches for `backchannelLogout.store` or `session.store` and
        // calls `destroy` on it — both are undefined here, so every callback
        // threw and every login answered 500, with the session cookie already
        // set: authenticated, and stuck on an error page.
        //
        // What it has to do is forget what would kill the session just
        // established. A mark on the `sub` kills every session of that
        // person, so left in place it would kill the ones created after it.
        onLogin: async (req: DmRequest): Promise<void> => {
          if (!this.server.hooks.oidclogin) return;
          const claims = (
            req as unknown as { oidc: { idTokenClaims: OidcSessionClaims } }
          ).oidc?.idTokenClaims;
          if (!claims) return;
          await launchHooks(this.server.hooks.oidclogin, claims);
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
    return config;
  }

  api(app: Express): void {
    const config = this.buildConfig();
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
