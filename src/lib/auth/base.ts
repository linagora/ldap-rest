import type { Express, Request, Response } from 'express';

import DmPlugin from '../../abstract/plugin';
import type { Config } from '../../config/args';
import { serverError } from '../../lib/expressFormatedResponses';
import { launchHooksChained } from '../../lib/utils';

/**
 * A request as the authentication plugins leave it.
 *
 * `user` is what an authorization rule is keyed on, and every authenticator
 * fills it with something different — a token's name, an OIDC `sub`, a
 * tenant. `userName` is the same caller under the name a person would use
 * for them, so a rule can be written once and survive a change of
 * authenticator; `--authz-identity` says which of the two the authorization
 * plugins read, and the default stays `user`, which changes nothing for an
 * existing deployment.
 */
export type DmRequest = Request & {
  user?: string;
  userName?: string;
  /**
   * The authentication plugins that vouched for this request, by instance
   * name, in the order the dispatcher ran them.
   *
   * Written by the dispatcher alone, once a plugin has let the request
   * through, so an authorization plugin can tell *whose* request it is
   * looking at: a machine token and an administrator's session carry
   * identities from different models, and a rule written for one of them
   * is not a judgement about the other (`--authz-for`).
   */
  authenticators?: string[];
};

/**
 * Drop the trailing slashes of a path prefix.
 *
 * Written as a scan rather than a `/\/+$/` replacement: that pattern
 * backtracks quadratically on a long run of slashes, which CodeQL flags as
 * a polynomial ReDoS. The value comes from the configuration rather than
 * from a request, so nothing was exploitable — but a linear scan says what
 * it does and costs nothing.
 *
 * @param path prefix to clean
 * @returns the prefix without its trailing slashes
 */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/**
 * Tell whether a mount prefix covers a request path, with the rule Express
 * itself applies: on segment boundaries, so `/api/m` covers `/api/m` and
 * `/api/m/entry` but never `/api/machines`.
 *
 * The catch-all uses this to decide what another plugin already guards, so
 * it must agree with Express exactly — a looser rule here would skip paths
 * nobody guards.
 *
 * @param prefix mount prefix
 * @param path request path
 * @returns true when the prefix covers the path
 */
export function prefixCoversPath(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** What `--authz-identity` accepts. */
const IDENTITY_MODES = ['req.user', 'req.userName'] as const;

/**
 * Refuse a `--authz-identity` nobody wrote.
 *
 * Called by every plugin that keys on an identity, at construction. A value
 * that is neither would otherwise mean `req.user` in silence, which is the
 * wrong half of a security option to guess at.
 *
 * @param config the server configuration
 * @param who the plugin asking, for the message
 * @throws Error when the value is not one of the two
 */
export function assertIdentityMode(config: Config, who: string): void {
  const mode = (config.authz_identity as string) ?? 'req.user';
  if (!(IDENTITY_MODES as readonly string[]).includes(mode))
    throw new Error(
      `${who}: unknown --authz-identity "${mode}". Known: ` +
        `${IDENTITY_MODES.join(', ')}.`
    );
}

/**
 * The value an authorization rule is keyed on.
 *
 * `req.user` is this server's identifier for the caller and differs per
 * authenticator — a token's name, an OIDC `sub`, a tenant — so a rule
 * written for one is inert under another. `req.userName` is the same caller
 * under a name a person would use, which is what makes a rule portable.
 *
 * When `req.userName` is asked for and missing, the answer falls back to
 * `req.user` rather than to nothing: an authenticated caller read as
 * anonymous would be *skipped* by the branch plugins, which is the one
 * outcome a misconfiguration must not produce. The caller is told so it can
 * say it once.
 *
 * @param req the request, or undefined
 * @param config the server configuration
 * @returns the identity to key on, and whether it is not the configured one
 */
export function identityFor(
  req: DmRequest | undefined,
  config: Config
): { value?: string; fellBack: boolean } {
  if (!req) return { fellBack: false };
  if ((config.authz_identity as string) !== 'req.userName')
    return { value: req.user, fellBack: false };
  if (req.userName) return { value: req.userName, fellBack: false };
  return { value: req.user, fellBack: Boolean(req.user) };
}

/**
 * What the loaded authenticators can name, and which of them cannot say.
 *
 * A rule is keyed on an identity, and a rule whose key no authenticator can
 * produce matches nothing — it is not refused, it is *inert*, and that reads
 * as a permission problem months later. Token, TOTP and HMAC names are in
 * the configuration, so this is answerable at startup for them; an identity
 * provider's claims are not, and saying "cannot verify" is the honest
 * answer rather than silence.
 *
 * @param loadedPlugins the server's plugin registry
 * @returns the identities that can be named, and the plugins that cannot say
 */
export function identityCoverage(loadedPlugins: Record<string, DmPlugin>): {
  known: Set<string>;
  unverifiable: string[];
} {
  const known = new Set<string>();
  const unverifiable: string[] = [];
  for (const plugin of Object.values(loadedPlugins)) {
    if (!plugin.roles?.includes('auth')) continue;
    const names = (
      plugin as DmPlugin & { knownIdentities?: () => string[] | undefined }
    ).knownIdentities?.();
    if (!names) unverifiable.push(plugin.name);
    else for (const name of names) known.add(name);
  }
  return { known, unverifiable };
}

/**
 * Say, once at startup, when configured rules name nobody.
 *
 * @param keys the identities the rules are written for
 * @param loadedPlugins the server's plugin registry
 * @param who the plugin asking
 * @param logger where to say it
 */
export function warnUnmatchedRuleKeys(
  keys: string[],
  loadedPlugins: Record<string, DmPlugin>,
  who: string,
  logger: {
    warn: (message: string) => unknown;
    info: (message: string) => unknown;
  }
): void {
  if (keys.length === 0) return;
  const { known, unverifiable } = identityCoverage(loadedPlugins);
  const matched = keys.filter(key => known.has(key));
  if (matched.length > 0) return;
  if (known.size === 0 && unverifiable.length === 0) return;
  const cannotSay = unverifiable.length
    ? ` ${unverifiable.join(', ')} cannot be checked before a login, so this ` +
      'may be right'
    : '';
  logger.warn(
    `${who}: none of its configured identities (${keys.join(', ')}) is one ` +
      `the loaded authenticators can publish${
        known.size ? ` (${[...known].join(', ')})` : ''
      }.${cannotSay || ' Every rule is inert.'}`
  );
}

export default abstract class AuthBase extends DmPlugin {
  abstract authMethod(req: DmRequest, res: Response, next: () => void): void;

  /** Validated prefixes, computed once: the catch-all reads them per request */
  private _pathPrefixes?: string[];

  /**
   * Path prefixes this authentication applies to, empty when it guards the
   * whole server.
   *
   * Loading the same plugin twice with different prefixes lets one server
   * serve populations that authenticate differently — machines with a token
   * on one branch of the API, administrators with an SSO session on another:
   *
   * ```
   * --plugin 'core/auth/token:tok:{"auth_path_prefix":"/api/m"}'
   * --plugin 'core/auth/openidconnect:oidc:{"auth_path_prefix":"/api/admin"}'
   * ```
   *
   * A credential is then only valid on the branch it was scoped to, which is
   * the point: a leaked machine token buys nothing on the admin API.
   *
   * A malformed entry is refused rather than skipped. Dropping one silently
   * would shrink what the plugin guards — the failure mode that leaves a
   * branch open while the configuration still reads as if it were covered.
   *
   * `/` is not a prefix but the whole server, so a list containing it makes
   * the plugin a catch-all: `["/", "/api/admin"]` guards everything, not
   * only `/api/admin`.
   *
   * @returns the configured prefixes without their trailing slashes, empty
   *          when the plugin guards the whole server
   * @throws Error when an entry is not a usable path prefix
   */
  get pathPrefixes(): string[] {
    if (this._pathPrefixes) return this._pathPrefixes;

    const configured = this.config.auth_path_prefix;
    const list = Array.isArray(configured)
      ? configured
      : configured
        ? [configured]
        : [];

    const prefixes: string[] = [];
    for (const entry of list) {
      // Plugin overrides are raw JSON, so an entry can be anything at all
      if (typeof entry !== 'string')
        throw new Error(
          `${this.name}: auth_path_prefix must contain strings, got ` +
            `${JSON.stringify(entry)}`
        );

      const trimmed = entry.trim();
      const prefix = stripTrailingSlashes(trimmed);
      if (prefix.length === 0) {
        if (trimmed.length === 0)
          throw new Error(
            `${this.name}: auth_path_prefix contains an empty entry`
          );
        // Only slashes: the plugin guards everything, whatever else is listed
        this.logger.info(
          `${this.name}: auth_path_prefix contains "${trimmed}", which covers ` +
            'the whole server: this authentication guards every path'
        );
        return (this._pathPrefixes = []);
      }
      if (!prefix.startsWith('/'))
        throw new Error(
          `${this.name}: auth_path_prefix entry "${entry}" must start with ` +
            '"/", otherwise it matches no request and guards nothing'
        );
      prefixes.push(prefix);
    }
    return (this._pathPrefixes = prefixes);
  }

  /**
   * Run this plugin's authentication on a request, hooks included.
   *
   * The dispatcher calls this; the plugin no longer owns a layer of its own.
   *
   * @param req incoming request
   * @param res response, ended here when authentication fails
   * @param next called only when the request is authenticated
   */
  async authenticate(
    req: Request,
    res: Response,
    next: () => void
  ): Promise<void> {
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
        // Unconditionally, as `beforeAuth` above. It used to run only when
        // the authenticating plugin declared a hook of its own named
        // `onAuth` — a flag no plugin in this repository sets, so the
        // documented extension point never fired for anyone: the auth
        // README's worked example, the OIDC page's, and `rateLimit`'s own
        // description of how it tracks failed attempts.
        [req, res] = await launchHooksChained(this.server.hooks.afterAuth, [
          req,
          res,
        ]);
        next();
      } catch (err) {
        serverError(res, err as Error);
      }
    });
  }

  /**
   * Publish the caller, under both names.
   *
   * Every authenticator calls this rather than assigning `req.user` itself,
   * so that the second value cannot be forgotten by one of them — which is
   * how a rule keyed on it would silently stop matching for that
   * population.
   *
   * @param req request being authenticated
   * @param user what authorization rules are keyed on, this plugin's own
   *             identifier for the caller
   * @param userName the caller under a name a person would use, when the
   *                 plugin has one; the identifier otherwise
   */
  protected publishIdentity(
    req: DmRequest,
    user: string,
    userName?: string
  ): void {
    req.user = user;
    req.userName = userName || user;
  }

  /**
   * The identities this plugin can publish, when they are known before any
   * request arrives.
   *
   * A configuration lists token, TOTP and HMAC names, so those plugins can
   * answer; an identity provider's claims are only known once someone logs
   * in, so those answer undefined and the check says so rather than
   * guessing.
   *
   * @returns the identities, or undefined when they cannot be known
   */
  protected knownIdentities(): string[] | undefined {
    return undefined;
  }

  /**
   * Where the values this plugin publishes come from, for the startup line.
   *
   * Said once at startup because the mismatch it guards against — a rule
   * written for one authenticator, inert under another — is invisible
   * until a request arrives, and then reads as a permission problem.
   *
   * @returns a sentence naming both sources
   */
  protected identitySource(): string {
    return 'req.user and req.userName: the name this plugin knows the caller by';
  }

  /**
   * Say what this plugin will publish, once every plugin is loaded.
   *
   * A subclass overriding `afterLoad` for its own checks should call this
   * one too.
   */
  afterLoad(): void {
    this.logger.info(`${this.name}: ${this.identitySource()}`);
  }

  /** Requests this plugin let through without authenticating them. */
  private readonly passedThrough = new WeakSet<object>();

  /**
   * Let a request through without vouching for it.
   *
   * The dispatcher records every plugin that calls `next()` as having
   * authenticated the request, and an authorization plugin scoped with
   * `--authz-for` judges by that record. A plugin that steps aside — a
   * bypass naming what *another* plugin authenticated, a verdict deferred to
   * the end of the chain — has not, and must not appear there: a plugin
   * scoped to it would judge requests whose identity it never produced.
   *
   * @param req the request passed on
   * @param next continuation
   */
  protected passThrough(req: Request, next: () => void): void {
    this.passedThrough.add(req);
    next();
  }

  /**
   * Whether this plugin authenticated the request it just let through.
   *
   * @param req a request this plugin called `next()` for
   * @returns false when it only stepped aside
   */
  vouchedFor(req: Request): boolean {
    return !this.passedThrough.has(req);
  }

  /**
   * A verdict this plugin could not reach while the chain was still running.
   *
   * The dispatcher calls it, on every selected plugin that implements it,
   * once each of them has authenticated and before any route sees the
   * request — the only moment where `req.user` is final and nothing has
   * answered yet. A plugin needing it must not mount a middleware of its
   * own: `api()` runs during registration, so such a middleware lands
   * wherever that plugin fell among the others, and a route plugin
   * registered first answers before it.
   *
   * `onAuth`/`afterAuth` are not that moment either: they run inside this
   * plugin's own `authenticate`, while the authenticators after it have yet
   * to run.
   *
   * Implement it only to answer a question that depends on what the *other*
   * authenticators did — `core/auth/authzDynamic` uses it to apply a bypass
   * written in terms of an identity another plugin publishes. Calling
   * `next()` passes the request on; ending the response refuses it.
   *
   * @param req the authenticated request
   * @param res response, ended by the plugin when it refuses
   * @param next continuation, called when the plugin has nothing to say
   */
  afterChain?(req: DmRequest, res: Response, next: () => void): void;

  /**
   * Register with the server's authentication dispatcher instead of mounting
   * a middleware.
   *
   * Mounting per plugin made protection depend on registration order: a
   * plugin whose `app.use` landed after the routes it was meant to guard
   * never ran for them, and the catch-all — stepping aside for a branch that
   * guard was supposed to cover — turned that into anonymous access. The
   * dispatcher is mounted by `DM` before any plugin loads, so it always
   * precedes every route, whatever order the plugins register in.
   *
   * @param _app unused: the dispatcher owns the only authentication layer
   */
  api(_app: Express): void {
    const prefixes = this.pathPrefixes;
    this.server.registerAuthenticator(this);
    this.logger.info(
      prefixes.length === 0
        ? `${this.name}: authentication guards every path not claimed by another plugin`
        : `${this.name}: authentication restricted to ${prefixes.join(', ')}`
    );
  }
}
