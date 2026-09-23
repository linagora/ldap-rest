import type { Express, RequestHandler, Response } from 'express';
import { auth, requiresAuth, ConfigParams } from 'express-openid-connect';

import AuthBase, { DmRequest } from '../../lib/auth/base';
import { type Role } from '../../abstract/plugin';
import { launchHooks, launchHooksChained } from '../../lib/utils';
import { serverError } from '../../lib/expressFormatedResponses';
import { DM } from '../../bin';
import type { OidcLogoutToken, OidcSessionClaims } from '../../hooks';

/**
 * The routes `express-openid-connect` serves itself.
 *
 * They belong to this plugin whatever it is scoped to: a provider has to be
 * able to reach the callback and to POST a logout token, and a catch-all
 * authentication answering `/callback` with a 401 breaks every login.
 */
const OWN_ROUTES = ['/login', '/logout', '/callback', '/backchannel-logout'];

export default class OpenIDConnect extends AuthBase {
  name = 'openidconnect';
  roles: Role[] = ['auth'] as const;
  /** The library's router, built once: `auth()` returns a fresh one per call. */
  private router?: RequestHandler;

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
      // The router reads the session and stops there. Whether a request
      // needs one is asked after it, by `requiresAuth()` in `authMethod`:
      // with `authRequired` here, a request reaching this plugin before the
      // router has installed `req.oidc` fails with "req.oidc is not found",
      // and the decision would be taken inside a layer the dispatcher
      // cannot order.
      authRequired: false,
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

  /**
   * Paths this authentication claims.
   *
   * Its own routes come with it. Scoped to `/api/admin`, the plugin would
   * otherwise leave `/callback` to whatever else guards the server — a
   * catch-all token plugin answering the provider's redirect with a 401 —
   * so the four are claimed too, which also keeps them out of every other
   * plugin's catch-all.
   *
   * Unscoped, the plugin already guards everything and the list stays empty.
   *
   * @returns the prefixes the dispatcher routes here
   */
  get pathPrefixes(): string[] {
    const configured = super.pathPrefixes;
    if (configured.length === 0) return configured;
    return [...configured, ...OWN_ROUTES];
  }

  /**
   * Register with the dispatcher, like every other authentication plugin.
   *
   * This plugin used to mount three layers of its own — the `beforeAuth`
   * hooks, the library's router, then the identity — which kept their
   * registration order. An instance carrying a name, the only form that can
   * hold `auth_path_prefix`, landed in the parallel batch and mounted after
   * the plugins that were supposed to read what it publishes: with
   * `core/auth/authzPerRoute` loaded, every rule was judged before
   * `req.user` existed, and `authzPerRoute` passes a request it cannot
   * identify. The rules read as enforced and were inert.
   *
   * The dispatcher is mounted before any plugin can register a route, runs
   * only the plugin whose claim is most specific, and hands `authMethod`
   * the `beforeAuth`/`afterAuth` hooks — the three layers, in a place where
   * order is not a configuration accident.
   *
   * @param app the express application
   */
  api(app: Express): void {
    this.router = auth(this.buildConfig());
    super.api(app);
  }

  /**
   * Read the session, then require one.
   *
   * `requiresAuth()` runs *after* the router, so `req.oidc` exists when the
   * decision is taken. It redirects a browser to the provider and answers
   * 401 to an API client, which is the library's default and what makes a
   * login work at all; the other authentication plugins answer JSON 401
   * throughout, and that difference is documented rather than smoothed over.
   *
   * The plugin's own routes never reach the second step: the router answers
   * them itself.
   *
   * @param req incoming request
   * @param res response, ended by the library when it refuses or redirects
   * @param next called once the request carries an identity
   */
  authMethod(req: DmRequest, res: Response, next: () => void): void {
    if (!this.router)
      return serverError(
        res,
        new Error(`${this.name}: api() has not built the router`)
      );
    this.router(req, res, (err?: unknown) => {
      if (err) return serverError(res, err as Error);
      requiresAuth()(req, res, () => {
        // @ts-expect-error request is augmented by express-openid-connect
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        req.user = req.oidc.user.sub;
        next();
      });
    });
  }
}
