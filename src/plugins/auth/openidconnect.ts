import { randomUUID } from 'crypto';

import type { Express, RequestHandler, Response } from 'express';
import oidc from 'express-openid-connect';
import type { ConfigParams } from 'express-openid-connect';

// Taken off the default export, not imported by name. The package is
// CommonJS, and Node detects the named exports an ESM file may import by
// reading `module.exports` statically — `auth` is a plain property there and
// is seen, `requiresAuth` arrives through a spread and is not. A named
// import of it type-checks (the `.d.ts` declares it) and links under a test
// runner's lenient interop, then fails at startup on the only path a
// deployment uses: `Named export 'requiresAuth' not found`. `core/auth/llng`
// is built the same way, for the same reason.
const { auth, requiresAuth } = oidc;

import AuthBase, { DmRequest } from '../../lib/auth/base';
import { type Role } from '../../abstract/plugin';
import { serverError, unauthorized } from '../../lib/expressFormatedResponses';
import { DM } from '../../bin';
import type { OidcLogoutToken, OidcSessionClaims } from '../../hooks';

import { openidconnectOptions } from './auth.options';

/**
 * The routes this plugin answers itself: `/logout` in `authMethod`, the others
 * through `express-openid-connect`.
 *
 * They belong to this plugin whatever it is scoped to: a provider has to be
 * able to reach the callback and to POST a logout token, and a catch-all
 * authentication answering `/callback` with a 401 breaks every login.
 */
const OWN_ROUTES = ['/login', '/logout', '/callback', '/backchannel-logout'];

/**
 * How `openid-client` refuses to build a logout URL for a provider whose
 * discovery document names no `end_session_endpoint`.
 */
const NO_END_SESSION = /^end_session_endpoint must be configured/;

/** `/logout` as express matches a route: any case, trailing slash or not. */
const LOGOUT = /^\/logout\/?$/i;

/**
 * Where the session keeps the id this server gave it at login, the one
 * `/logout` ends it by.
 */
const SESSION_ID = 'dmSession';

/** The session as the library holds it, once its router has run */
type OidcRequest = {
  oidc: {
    isAuthenticated(): boolean;
    idTokenClaims?: OidcSessionClaims;
  };
  appSession?: Record<string, unknown>;
};

/**
 * What names the session in front of a request: the provider's claims, and
 * the id given at login. A session from before that id existed has none.
 */
const sessionClaims = (req: DmRequest): OidcSessionClaims | undefined => {
  const { oidc, appSession } = req as unknown as OidcRequest;
  const claims = oidc?.idTokenClaims;
  if (!claims) return undefined;
  const id = appSession?.[SESSION_ID];
  return typeof id === 'string' ? { ...claims, session: id } : claims;
};

/**
 * The `sub` of an id token the library has just verified, or undefined.
 *
 * `afterCallback` receives the tokens as plain values, the claims method
 * stripped off. Read without checking the signature, which holds because the
 * library calls `afterCallback` only once `client.callback()` has verified the
 * token: a version calling it earlier would hand this an unverified `sub`.
 */
const subjectOf = (idToken: unknown): string | undefined => {
  try {
    const payload = JSON.parse(
      Buffer.from(String(idToken).split('.')[1], 'base64url').toString()
    ) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
};

export default class OpenIDConnect extends AuthBase {
  static optionDefinitions = openidconnectOptions;

  name = 'openidconnect';
  // A scoped instance must carry a name, and a front-end looks for the
  // logout route here whatever it is.
  configApiKey = 'openidconnect';
  roles: Role[] = ['auth', 'configurable'] as const;
  /** The library's router, built once: `auth()` returns a fresh one per call. */
  private router?: RequestHandler;
  /** Set once the missing `end_session_endpoint` has been reported. */
  private warnedNoEndSession = false;
  /** Set once a `/logout` with nothing to record it has been reported. */
  private warnedNoRecord = false;
  /** Set once a `/logout` of a session nothing names has been reported. */
  private warnedUnnamed = false;

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
    const settings = this.options(openidconnectOptions);
    const config: ConfigParams = {
      // The router reads the session and stops there. Whether a request
      // needs one is asked after it, by `requiresAuth()` in `authMethod`:
      // with `authRequired` here, a request reaching this plugin before the
      // router has installed `req.oidc` fails with "req.oidc is not found",
      // and the decision would be taken inside a layer the dispatcher
      // cannot order.
      authRequired: false,
      issuerBaseURL: settings.oidc_server,
      clientID: settings.oidc_client_id,
      secret: settings.oidc_client_secret,
      baseURL: settings.base_url,
      clientSecret: settings.oidc_client_secret,
      authorizationParams: {
        response_type: 'code',
        scope: 'openid profile email',
      },
      // RP-Initiated Logout: `/logout` sends the browser to the provider's
      // `end_session_endpoint`, which closes the SSO session and tells the
      // other applications through Back-Channel Logout. Left off, `/logout`
      // only dropped the cookie, and the next request went through the
      // provider and came back logged in without being asked anything: a
      // logout with nothing to show for it.
      //
      // The route is served in `authMethod` rather than by the library,
      // which always sends a `post_logout_redirect_uri` — one the provider
      // refuses unless it was registered, for a return nobody needs: the
      // provider's own logout page is where the caller is done.
      idpLogout: true,
      routes: { logout: false },
      // The id `/logout` ends this session by. The cookie holds the whole
      // session, so dropping it ends only the browser's copy; a copy kept
      // elsewhere stays valid until its tokens expire. Nothing else names
      // one session: a provider may send no `sid` (Dex sends none), and a
      // mark on the `sub` would end every session of that person.
      afterCallback: async (req, _res, session) => ({
        ...session,
        [SESSION_ID]: await this.sessionId(
          req as unknown as DmRequest,
          subjectOf((session as { id_token?: unknown }).id_token)
        ),
      }),
      // Back-Channel Logout, handed to whoever subscribed. This plugin knows
      // how to receive a logout token and how to ask whether the session in
      // front of it is still alive; where that answer is kept is a plugin of
      // its own. Both hooks are supplied rather than a store, which is what
      // lets the session stay in the cookie: only what is dead is recorded.
      backchannelLogout: {
        onLogoutToken: async (decoded: object): Promise<void> => {
          if (!this.server.hookBus.has('oidclogouttoken')) {
            // The route exists as soon as this plugin does, so without a
            // subscriber the provider is told the logout succeeded and
            // nothing acts on it. Say so rather than drop it in silence.
            this.logger.warn(
              'openidconnect: a logout token arrived but no Back-Channel ' +
                'Logout plugin is loaded, so nothing records it'
            );
            return;
          }
          // The failure has to reach the library, which answers 400 and lets
          // the provider retry, where a notification would leave it told 204
          // about a logout nothing kept.
          await this.hookBus.notifyStrict(
            'oidclogouttoken',
            decoded as OidcLogoutToken
          );
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
          if (!this.server.hookBus.has('oidclogin')) return;
          const claims = (
            req as unknown as { oidc: { idTokenClaims: OidcSessionClaims } }
          ).oidc?.idTokenClaims;
          if (!claims) return;
          // Not a notification either, and not for the provider's benefit:
          // what these subscribers do is clear what would refuse the session
          // just established. `bcl` deletes the mark its logout token set on
          // the `sub`, and a mark left in place kills every session of that
          // person — `oidcsessionvalid` reads it without comparing any
          // timestamp. Swallowing the failure would hand the caller a login
          // that works and a next request already refused, which behind a
          // provider that logs back in on its own is a loop of the two.
          try {
            await this.hookBus.notifyStrict('oidclogin', claims);
          } catch (err) {
            // The session is already in `req.appSession` by the time this
            // runs — the library's `callback()` fills it before calling the
            // hook — and its `appSession` middleware writes whatever is
            // there into the cookie on the way out, the response to a
            // rethrown error included. A refusal that left it in place would
            // answer the caller with an error *and* a working session; on
            // the silent path, which redirects instead of failing, it would
            // send a live session and no error at all. Emptying it is what
            // makes the refusal hold on its own, rather than by the mark the
            // subscriber failed to clear.
            const session = (
              req as unknown as { appSession?: Record<string, unknown> }
            ).appSession;
            if (session)
              for (const key of Object.keys(session)) delete session[key];
            throw err;
          }
        },

        isLoggedOut: (req: DmRequest): Promise<boolean> => this.loggedOut(req),
      },
    };
    return config;
  }

  protected identitySource(): string {
    const claim = this.options(openidconnectOptions).oidc_username_claim;
    return (
      'req.user: the OIDC sub, an opaque provider identifier; req.userName: ' +
      `the "${claim}" claim` +
      (claim === 'sub'
        ? ' — the same value, until --oidc-username-claim names another'
        : '')
    );
  }

  /**
   * What `GET /v1/config` publishes under `features`.
   *
   * A front-end served by this server cannot tell otherwise that a session
   * can be ended here: the logout route is this plugin's, and exists only
   * when it is loaded.
   *
   * @returns the logout route, relative to the server root
   */
  getConfigApiData(): Record<string, unknown> {
    return { enabled: true, endpoints: { logout: '/logout' } };
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
   * order is not a configuration accident. (`afterAuth` used to be gated on
   * a flag nothing sets, so this plugin's own copy of it never ran either.)
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
      if (err && LOGOUT.test(req.path) && this.noEndSession(err))
        // The library clears the session before it asks for the provider's
        // logout URL, so what is left is the redirect it could not build.
        // The provider's session survives and will log the caller back in:
        // that is the provider's limit, and a 500 would not lift it.
        return res.redirect(this.options(openidconnectOptions).base_url);
      if (err) return serverError(res, err as Error);
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        LOGOUT.test(req.path)
      )
        // A failure comes back through this same callback, as `err`.
        return void this.endHere(req).then(() =>
          (
            res as unknown as {
              oidc: { logout: (params: object) => Promise<void> };
            }
          ).oidc.logout({
            logoutParams: { post_logout_redirect_uri: undefined },
          })
        );
      const guard = (): void =>
        // No session: a browser has already been sent to the provider, an
        // API client comes back here with the refusal as `err`.
        void requiresAuth()(req, res, (err?: unknown) => {
          if (err) return unauthorized(res);
          const claims = (
            req as unknown as { oidc: { user: Record<string, unknown> } }
          ).oidc.user;
          const claim = this.options(openidconnectOptions).oidc_username_claim;
          const named = claims[claim];
          if (claim !== 'sub' && typeof named !== 'string')
            // Once per session rather than per request would need somewhere to
            // remember it; a provider that does not send the claim sends it for
            // nobody, so the line repeats until the configuration is fixed.
            this.logger.warn(
              `${this.name}: no "${claim}" claim on this session, so ` +
                'req.userName falls back to the sub. Check ' +
                '--oidc-username-claim against the scopes the provider is ' +
                'asked for'
            );
          this.publishIdentity(
            req,
            String(claims.sub),
            typeof named === 'string' ? named : String(claims.sub)
          );
          next();
        });
      // Synchronous unless a refresh token has to be sent: nothing else here
      // waits, and a request that needs no renewal is not made to.
      const renewal = this.renewExpired(req);
      if (renewal) void renewal.then(guard);
      else guard();
    });
  }

  /**
   * Keep a session no longer than its access token: past its expiry, renewed
   * with the refresh token when the provider gave one, ended otherwise, so
   * the caller goes back through the provider, which asks again if its own
   * session is over.
   *
   * The library leaves the cookie alive for its own duration, a day of
   * inactivity and a week at most, whatever the provider said, and nothing
   * here reads the access token otherwise. A token with no expiry is kept.
   *
   * @param req the request, after the library's router
   * @returns the renewal under way, which never rejects: a refused or failed
   * one ends the session. Undefined when there is nothing to wait for.
   */
  private renewExpired(req: DmRequest): Promise<void> | undefined {
    const oidc = (
      req as unknown as {
        oidc: {
          refreshToken?: string;
          accessToken?: { isExpired(): boolean; refresh(): Promise<unknown> };
        };
      }
    ).oidc;
    const token = oidc.accessToken;
    if (!token?.isExpired()) return undefined;
    // As a back-channel logout does: no session, so `requiresAuth` sends the
    // caller to the provider, or answers 401 to an API client.
    const end = (): void => {
      (req as unknown as { appSession?: unknown }).appSession = undefined;
    };
    if (!oidc.refreshToken) return void end();
    return token.refresh().then(
      () => undefined,
      (err: unknown) => {
        this.logger.info(
          `${this.name}: the provider refused to renew an access token, ` +
            `so the session ends: ${String(err)}`
        );
        end();
      }
    );
  }

  /**
   * Whether the session in front of a request was ended — by a logout token,
   * or by `/logout`.
   *
   * @param req the request, after the library has read its session
   * @returns true when a subscriber of `oidcsessionvalid` refuses it
   */
  private async loggedOut(req: DmRequest): Promise<boolean> {
    if (!this.server.hookBus.has('oidcsessionvalid')) return false;
    const claims = sessionClaims(req) as OidcSessionClaims;
    const [, valid] = await this.hookBus.chain('oidcsessionvalid', [
      claims,
      true,
    ]);
    return !valid;
  }

  /**
   * The id a session gets at login.
   *
   * The same person logging in again over a live session keeps its id: the
   * library merges the new tokens into that session, and a copy of its
   * cookie taken before would otherwise carry an id the next `/logout` no
   * longer names. Anyone else, or a session already ended — the callback
   * runs before the library asks — gets a new one.
   *
   * @param req the callback request, its session as the cookie brought it
   * @param sub the `sub` of the id token just received
   * @returns the id to keep in the session
   */
  private async sessionId(
    req: DmRequest,
    sub: string | undefined
  ): Promise<string> {
    const { oidc, appSession } = req as unknown as OidcRequest;
    const kept = appSession?.[SESSION_ID];
    if (
      typeof kept === 'string' &&
      sub !== undefined &&
      oidc?.isAuthenticated() &&
      oidc.idTokenClaims?.sub === sub &&
      // A store that cannot answer is no proof the session is alive
      !(await this.loggedOut(req).catch(() => true))
    )
      return kept;
    return randomUUID();
  }

  /**
   * Record that the session in front of `/logout` is dead, as a logout token
   * naming it would.
   *
   * Dropping the cookie ends the browser's copy only: the cookie holds the
   * whole session, and a copy kept elsewhere — a shared computer, a backup
   * of the browser profile, a stolen cookie — stayed valid until its tokens
   * expired. The provider ends the sessions of the other applications
   * through Back-Channel Logout, but does not tell the one that asked it to.
   *
   * The session is named by the id given at login, or by the provider's
   * `sid` for a session from before that id existed — never by the `sub`,
   * which would end every session of that person.
   *
   * A failure to record is logged and the logout goes on: the caller asked
   * to leave, and refusing would keep the browser's copy alive as well.
   *
   * @param req the request, after the library's router
   * @returns once the subscribers have run; never rejects
   */
  private async endHere(req: DmRequest): Promise<void> {
    if (!(req as unknown as OidcRequest).oidc?.isAuthenticated()) return;
    const claims = sessionClaims(req);
    if (!claims) return;
    const { iss, sid, session } = claims;
    const dead: OidcLogoutToken | undefined = session
      ? { iss, session }
      : sid
        ? { iss, sid }
        : undefined;
    if (!dead) {
      if (!this.warnedUnnamed) {
        this.warnedUnnamed = true;
        this.logger.warn(
          `${this.name}: /logout ended a session nothing names — one ` +
            'established before this version, from a provider that sends ' +
            'no sid — so a copy of its cookie stays valid until its tokens ' +
            'expire'
        );
      }
      return;
    }
    if (!this.server.hookBus.has('oidclogouttoken')) {
      if (!this.warnedNoRecord) {
        this.warnedNoRecord = true;
        this.logger.warn(
          `${this.name}: no Back-Channel Logout plugin is loaded, so ` +
            "/logout drops the browser's cookie and nothing else: a copy " +
            'of it stays valid until its tokens expire. Load core/bcl to ' +
            'end the session here as well'
        );
      }
      return;
    }
    try {
      await this.hookBus.notifyStrict('oidclogouttoken', dead);
    } catch (err) {
      this.logger.error(
        `${this.name}: /logout could not record the session it ends, so a ` +
          `copy of its cookie stays valid until its tokens expire: ${String(err)}`
      );
    }
  }

  /**
   * Whether `/logout` failed because the provider offers no RP-Initiated
   * Logout, rather than for a reason worth a 500.
   *
   * Warned once: the provider's discovery document does not change while
   * the server runs.
   *
   * @param err what the library handed back
   * @returns true when the provider has no `end_session_endpoint`
   */
  private noEndSession(err: unknown): boolean {
    if (!(err instanceof Error) || !NO_END_SESSION.test(err.message))
      return false;
    if (!this.warnedNoEndSession) {
      this.warnedNoEndSession = true;
      this.logger.warn(
        `${this.name}: the provider publishes no end_session_endpoint, so ` +
          '/logout ends the session here only, and the provider may log ' +
          'the caller back in'
      );
    }
    return true;
  }
}
