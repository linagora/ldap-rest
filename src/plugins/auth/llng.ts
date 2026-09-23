/**
 * @module plugins/auth/llng
 * @group Plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Lemonldap::NG authentication plugin
 * This plugin enables authentication and authorization using Lemonldap::NG.
 */
import type { Express, Response } from 'express';

import AuthBase, { DmRequest } from '../../lib/auth/base';
import type { Role } from '../../abstract/plugin';

// The ambient declaration for `lemonldap-ng-handler` lives in
// src/types/lemonldap-ng-handler.d.ts: `skipLibCheck` lets that fallback
// coexist with the package's own types when it is installed, whereas the
// same declaration written here, in a regular source file, would conflict
// with them.
type LlngHandler = typeof import('lemonldap-ng-handler');

/**
 * `lemonldap-ng-handler` keeps its state at the module level — `init()`
 * writes it, `run()` reads it, and both live in the package, not in any
 * object this plugin holds. `import()` caches the module, so every instance
 * of this plugin that goes through the real `loadHandler()` gets back the
 * very same object. Two instances of this plugin are a supported way to load
 * the same plugin twice, each under its own name and its own `llng_ini`
 * override (`--plugin 'core/auth/llng:llng2:{"llng_ini":"…"}'`, see
 * `DM.registerPlugin`); for this one plugin that pattern cannot work, because
 * the second `init()` would silently overwrite what the first one set, and
 * `authMethod` on either instance would then read whichever configuration
 * was initialized last. Track, per handler object, what it was initialized
 * from, and refuse a second, different one instead of leaving that silent.
 * Keyed on the handler rather than kept as a single module-level value so
 * that tests, which each hand `loadHandler()` a fresh fake object, do not
 * collide with one another.
 */
const initializedFrom = new WeakMap<LlngHandler, string>();

export default class AuthLLNG extends AuthBase {
  name = 'authLemonldapNg';
  roles: Role[] = ['auth'] as const;

  private handler?: LlngHandler;

  /**
   * Load the optional `lemonldap-ng-handler` dependency before the server
   * starts serving requests, rather than importing it statically.
   *
   * A static import would throw the moment this file is loaded — as soon as
   * this plugin is configured — with Node's own opaque "Cannot find
   * package" error. Loading it here instead means a server that never
   * configures this plugin never touches the package at all, and one that
   * does configure it gets a clear failure naming both the plugin and the
   * missing dependency, at startup, instead of on the first request an auth
   * plugin that cannot run must not pretend to succeed.
   */
  // AuthBase declares api() as returning void; DmPlugin's own api?() field
  // already allows MaybePromise<void>, and the caller in bin/index.ts always
  // awaits it — this override just uses the async result that permits.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async api(app: Express): Promise<void> {
    let handler: LlngHandler;
    try {
      handler = await this.loadHandler();
    } catch (err) {
      throw new Error(
        `${this.name}: requires the optional dependency "lemonldap-ng-handler", ` +
          'which is not installed. Install it to use this plugin, or remove ' +
          `it from the configuration. (${
            err instanceof Error ? err.message : String(err)
          })`
      );
    }
    // The handler knows nothing until it is initialized: which virtual hosts
    // it protects, where the configuration and the sessions live. `run()`
    // before `init()` reads an instance that does not exist yet and throws on
    // every request, so the plugin used to answer 500 to all of them while
    // `--llng-ini` was parsed and never read.
    // `--llng-ini` defaults to `/etc/lemonldap-ng/lemonldap-ng.ini`
    // (src/config/args.ts), so it names a real path in every deployment —
    // there is no "default configuration" case distinct from a confFile to
    // report. `Config` types every field optional regardless
    // (src/config/args.ts), which `?? ''` satisfies for the type checker
    // alone.
    const confFile = this.config.llng_ini ?? '';
    const previouslyFrom = initializedFrom.get(handler);
    if (previouslyFrom !== undefined && previouslyFrom !== confFile) {
      throw new Error(
        `${this.name}: lemonldap-ng-handler is already initialized from ` +
          `"${previouslyFrom}"; it keeps its state at the module level, so ` +
          `a second instance of this plugin cannot also use "${confFile}". ` +
          'Load one instance of this plugin, or point every instance at the ' +
          'same lemonldap-ng.ini.'
      );
    }
    try {
      await handler.init({ configStorage: { confFile } });
    } catch (err) {
      throw new Error(
        `${this.name}: cannot initialize the LemonLDAP::NG handler from ` +
          `${confFile}. Check that the file exists, that its [configuration] ` +
          'section is reachable and that [node-handler] lists this server ' +
          `in nodeVhosts. (${err instanceof Error ? err.message : String(err)})`
      );
    }
    initializedFrom.set(handler, confFile);
    this.handler = handler;
    super.api(app);
  }

  /**
   * Load the handler. Split out so tests can override it to simulate the
   * dependency being absent, without actually uninstalling it.
   */
  protected async loadHandler(): Promise<LlngHandler> {
    return import('lemonldap-ng-handler');
  }

  /**
   * The header the handler writes the identity to.
   *
   * `lemonldap-ng-handler` 3.x assigns it with that exact spelling —
   * `req.headers["Lm-Remote-User"] = session[this.tsv.whatToTrace]` in its
   * `sendHeaders` — while Node lower-cases every header that arrives on the
   * wire. The two never collide, which is what keeps a client from
   * supplying its own identity, and nothing in either project promises that
   * spelling: `dropForgedIdentity` below removes what a client sent, so the
   * plugin can then read whatever case the handler used.
   */
  private static readonly USER_HEADER = 'lm-remote-user';

  /**
   * Remove any identity header the request arrived with.
   *
   * Only the handler may name the caller. A client sending
   * `Lm-Remote-User: admin` reaches this plugin as `lm-remote-user`, and the
   * read below is case-insensitive, so without this it would be read as an
   * identity the handler never vouched for.
   *
   * @param req incoming request, whose headers are pruned in place
   */
  private static dropForgedIdentity(req: DmRequest, header?: string): void {
    const name = header ?? AuthLLNG.USER_HEADER;
    for (const key of Object.keys(req.headers))
      if (key.toLowerCase() === name) delete req.headers[key];
  }

  /**
   * A header's value, whatever case it was written in.
   *
   * @param req request the handler has just passed on
   * @param lowercased the header's name, already lower-cased
   * @returns its value, or undefined when it is not there
   */
  private static headerValue(
    req: DmRequest,
    lowercased: string
  ): string | undefined {
    for (const [key, value] of Object.entries(req.headers))
      if (key.toLowerCase() === lowercased && typeof value === 'string')
        return value;
    return undefined;
  }

  /**
   * The identity the handler vouched for, whatever case it wrote it in.
   *
   * @param req request the handler has just passed on
   * @returns the identity, or undefined when the handler named nobody
   */
  private static vouchedIdentity(req: DmRequest): string | undefined {
    return AuthLLNG.headerValue(req, AuthLLNG.USER_HEADER);
  }

  protected identitySource(): string {
    const header = (this.config.llng_username_header as string) || '';
    return (
      "req.user: LemonLDAP::NG's whatToTrace, via Lm-Remote-User; " +
      (header
        ? `req.userName: the ${header} header LLNG exports`
        : 'req.userName: the same value, until --llng-username-header names ' +
          'an exported header')
    );
  }

  authMethod(req: DmRequest, res: Response, next: () => void): void {
    // api() runs before any request reaches here and would already have
    // thrown if the dependency were missing, so this only guards against
    // authMethod being called out of order.
    if (!this.handler) {
      throw new Error(`${this.name}: lemonldap-ng-handler is not loaded`);
    }
    // Both names the client could supply, before the handler runs. The
    // second one matters as much as the first: `--llng-username-header`
    // names what `req.userName` is read from, an authorization rule can be
    // keyed on it (`--authz-identity req.userName`) and the SCIM base map
    // reads the same value — so a client sending `x-login: root` would take
    // over the identity a rule names. The handler writes the header under
    // the spelling LLNG's configuration gives it, and a lower-cased key
    // from the wire is a *different* key sitting earlier in the object,
    // which is the one a case-insensitive read finds first.
    const usernameHeader = (
      (this.config.llng_username_header as string) || ''
    ).toLowerCase();
    AuthLLNG.dropForgedIdentity(req);
    if (usernameHeader) AuthLLNG.dropForgedIdentity(req, usernameHeader);
    this.handler.run(req, res, () => {
      const user = AuthLLNG.vouchedIdentity(req);
      if (!user) {
        // The handler let the request through without naming anyone. Its
        // `skip` rules do exactly that — `run()` returns `next()` at once,
        // no session read, no header written — and publishing `undefined`
        // made every authorization plugin treat the request as anonymous
        // and skip its check, which reads as "authenticated but unscoped"
        // and is not.
        this.logger.warn(
          `${this.name}: the handler passed a request on without naming a ` +
            'user, which a `skip` rule does. Refusing rather than serving ' +
            'it with no identity'
        );
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      // A second header, when the deployment exports one: `whatToTrace` is
      // often a mail or a display name, and a rule written on logins needs
      // the login. Absent, both values are what the handler traced.
      const named = usernameHeader
        ? AuthLLNG.headerValue(req, usernameHeader)
        : undefined;
      this.publishIdentity(req, user, named);
      next();
    });
  }
}
