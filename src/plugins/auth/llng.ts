/**
 * @module plugins/auth/llng
 * @group Plugins
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * Lemonldap::NG authentication plugin
 * This plugin enables authentication and authorization using Lemonldap::NG.
 */
import type { Express, Response } from 'express';

import AuthBase, { DmRequest } from '../../lib/auth/base.js';
import type { Role } from '../../abstract/plugin.js';

import { llngOptions } from './auth.options.js';

/**
 * The part of `lemonldap-ng-handler` this plugin uses. The ambient
 * declaration in src/types/lemonldap-ng-handler.d.ts gives the module the
 * same shape for the build; this interface is what the published declaration
 * names, so a consumer without the package still sees it.
 */
interface LlngHandler {
  init(args: {
    configStorage?: { confFile?: string; [key: string]: unknown };
    type?: string;
  }): Promise<unknown>;
  run(req: DmRequest, res: Response, next: () => void): void;
}

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

/**
 * The part of the handler `init()` resolves to that this plugin reads: the
 * location rules of each virtual host, compiled. The package does not
 * declare it; `unfoldableKeys` refuses to guess when it is not there.
 */
interface LlngInstance {
  tsv?: { locationRegexp?: Record<string, Array<{ source: string }>> };
}

/**
 * What an escape stands for: the character it encodes, `capital` for a
 * property only capitals have, or undefined for a class or an assertion.
 *
 * @param escape the escape, backslash included, as RE2 accepts it
 */
function escaped(escape: string): string | undefined {
  const hex = /^\\x(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{2}))$/i.exec(escape);
  if (hex)
    return String.fromCodePoint(
      Math.min(parseInt(hex[1] ?? hex[2], 16), 0x10ffff)
    );
  if (/^\\[0-7]{1,3}$/.test(escape))
    return String.fromCharCode(parseInt(escape.slice(1), 8));
  if (
    /^\\p\{(?:Lu|Lt|Upper|Uppercase|Uppercase_Letter|Titlecase_Letter)\}$/.test(
      escape
    )
  )
    return 'capital';
  if (/^\\[^a-zA-Z0-9]$/.test(escape)) return escape[1];
  return undefined;
}

/** An escape at the start of `rest`, `\Q…\E` included */
const ESCAPE =
  /^\\(?:x\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[pP]\{[^}]*\}|Q[^]*?(?:\\E|$)|[^])/;

const isCapital = (c: string | undefined): boolean =>
  c === 'capital' || (c !== undefined && /^[\p{Lu}\p{Lt}]$/u.test(c));

/** Whether every character from `first` to `last` is a capital */
function capitalsOnly(first: string, last: string): boolean {
  const from = first.codePointAt(0);
  const to = last.codePointAt(0);
  if (from === undefined || to === undefined || to - from > 0xffff)
    return false;
  for (let code = from; code <= to; code++)
    if (!isCapital(String.fromCodePoint(code))) return false;
  return true;
}

/**
 * The first capital letter a compiled location key requires outside a part
 * that ignores case, or undefined when it has none.
 *
 * It errs on the side of refusing: an optional capital (`U?`), an
 * alternative (`(U|u)`) or a class of capitals only (`[A-Z]`) count, while
 * `[Uu]`, `(?i)`, `(?i:…)` and escapes that do not encode a capital do not.
 * The hexadecimal digits of a `%XX` do not either: the handler matches the
 * path with its non-ASCII characters encoded that way, digits in upper case.
 *
 * @param source the key as RE2 compiled it
 */
function requiredCapital(source: string): string | undefined {
  const ignoring = [false];
  for (let i = 0; i < source.length; i++) {
    const folded = ignoring[ignoring.length - 1];
    const rest = source.slice(i);
    if (rest[0] === '(') {
      const flags = /^\(\?([imsU]*)(?:-([imsU]*))?([:)])/.exec(rest);
      let inner = folded;
      if (flags) {
        if (flags[1].includes('i')) inner = true;
        if (flags[2]?.includes('i')) inner = false;
        i += flags[0].length - 1;
        if (flags[3] === ')') {
          ignoring[ignoring.length - 1] = inner;
          continue;
        }
      } else {
        i += (/^\(\?P?<[^>]*>/.exec(rest)?.[0].length ?? 1) - 1;
      }
      ignoring.push(inner);
      continue;
    }
    if (rest[0] === ')') {
      if (ignoring.length > 1) ignoring.pop();
      continue;
    }
    if (rest[0] === '[') {
      const negated = rest[1] === '^';
      let j = negated ? 2 : 1;
      let onlyCapitals = true;
      let first = true;
      while (j < rest.length && (rest[j] !== ']' || first)) {
        first = false;
        let member: string | undefined;
        const posix = /^\[:(\^?)([a-z]+):\]/.exec(rest.slice(j));
        const escape = rest[j] === '\\' ? ESCAPE.exec(rest.slice(j)) : null;
        if (posix) {
          member = posix[1] === '' && posix[2] === 'upper' ? 'capital' : '';
          j += posix[0].length;
        } else if (escape) {
          member = escaped(escape[0]) ?? '';
          j += escape[0].length;
        } else {
          member = rest[j];
          j++;
        }
        if (rest[j] === '-' && rest[j + 1] !== ']' && j + 1 < rest.length) {
          const end =
            rest[j + 1] === '\\' ? ESCAPE.exec(rest.slice(j + 1)) : null;
          const last = end ? (escaped(end[0]) ?? '') : rest[j + 1];
          j += end ? end[0].length + 1 : 2;
          if (!capitalsOnly(member, last)) onlyCapitals = false;
          continue;
        }
        if (!isCapital(member)) onlyCapitals = false;
      }
      const klass = rest.slice(0, j + 1);
      i += j;
      if (!folded && !negated && onlyCapitals && !first) return klass;
      continue;
    }
    let literal: string | undefined = rest[0];
    if (rest[0] === '\\') {
      const escape = ESCAPE.exec(rest);
      if (!escape) break;
      i += escape[0].length - 1;
      if (escape[0][1] === 'Q') {
        const quoted = /[\p{Lu}\p{Lt}]/u.exec(
          escape[0].slice(2).replace(/\\E$/, '')
        );
        if (!folded && quoted) return escape[0];
        continue;
      }
      literal = escaped(escape[0]);
      if (!folded && isCapital(literal)) return escape[0];
      continue;
    }
    if (rest[0] === '%' && /^%[0-9a-fA-F]{2}/.test(rest)) {
      i += 2;
      continue;
    }
    if (!folded && isCapital(literal)) return literal;
  }
  return undefined;
}

export default class AuthLLNG extends AuthBase {
  static optionDefinitions = llngOptions;

  name = 'authLemonldapNg';
  roles: Role[] = ['auth'] as const;

  private handler?: LlngHandler;
  private instance?: LlngInstance;
  /** How many keys of each list of location rules were found foldable */
  private readonly foldable = new WeakMap<object, number>();

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
    // (auth.options.ts), so it names a real path in every deployment — there
    // is no "default configuration" case distinct from a confFile to report.
    const confFile = this.options(llngOptions).llng_ini;
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
      this.instance = (await handler.init({
        configStorage: { confFile },
      })) as LlngInstance;
    } catch (err) {
      throw new Error(
        `${this.name}: cannot initialize the LemonLDAP::NG handler from ` +
          `${confFile}. Check that the file exists, that its [configuration] ` +
          'section is reachable and that [node-handler] lists this server ' +
          `in nodeVhosts. (${err instanceof Error ? err.message : String(err)})`
      );
    }
    const unfoldable = this.unfoldableKeys();
    if (unfoldable)
      throw new Error(`${this.name}: ${unfoldable} (in ${confFile})`);
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

  /**
   * The request as the handler must see it: its path in lower case, the
   * characters it sends percent-encoded included.
   *
   * Express routes this server ignoring case, while the handler matches its
   * location rules case-sensitively: `/API/V1/LDAP/USERS` reaches the routes
   * of `/api/v1/ldap/users` without matching `^/api/v1/ldap/users`, and would
   * be judged by `default`. The handler also decodes the ASCII letters of a
   * `%XX` before matching, so an encoded capital (`/users/%42ob`) would
   * escape a rule naming the entry in lower case; a non-ASCII one stays
   * encoded (`%C3%89` for `É`), and is folded to its lower case encoded.
   *
   * The handler writes the headers it exports into `req.headers`; the copy
   * shares that object with the request, and nothing else is changed on it.
   *
   * @param req incoming request
   * @returns the request itself when its path is already folded
   */
  private static foldedPath(req: DmRequest): DmRequest {
    const url = req.url;
    if (typeof url !== 'string') return req;
    const query = url.indexOf('?');
    const path = query === -1 ? url : url.slice(0, query);
    const folded = path.toLowerCase().replace(/(?:%[0-9a-f]{2})+/g, run => {
      let text: string;
      try {
        text = decodeURIComponent(run);
      } catch {
        return run;
      }
      return Array.from(text.toLowerCase(), c =>
        /^[a-z0-9]$/.test(c) ? c : encodeURIComponent(c)
      ).join('');
    });
    if (folded === path) return req;
    return Object.create(req, {
      url: {
        value: query === -1 ? folded : folded + url.slice(query),
        writable: true,
        configurable: true,
        enumerable: true,
      },
    }) as DmRequest;
  }

  /**
   * Find a location key that may need a capital letter, which the folded path
   * never has: it would let the paths it names fall to `default`. See
   * `requiredCapital`. The handler compiles the keys again whenever its
   * configuration reloads, so this runs on every request; a list already
   * read is not read again.
   *
   * @returns what is wrong, or undefined when every key can match
   */
  private unfoldableKeys(): string | undefined {
    const rules = this.instance?.tsv?.locationRegexp;
    if (!rules || typeof rules !== 'object')
      return (
        'cannot read the location rules of lemonldap-ng-handler, which this ' +
        'plugin checks: this version of the package is not supported'
      );
    for (const [vhost, list] of Object.entries(rules)) {
      if (!Array.isArray(list)) continue;
      const checked = this.foldable.get(list) ?? 0;
      for (const { source } of list.slice(checked)) {
        const capital =
          typeof source === 'string' ? requiredCapital(source) : undefined;
        if (capital)
          return (
            `the location rule ${source} of ${vhost} may need a capital ` +
            `letter (${capital}), and the handler is given the path in ` +
            'lower case. Write the key in lower case, or start it with (?i)'
          );
      }
      this.foldable.set(list, list.length);
    }
    return undefined;
  }

  protected identitySource(): string {
    const header = this.options(llngOptions).llng_username_header;
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
    const usernameHeader =
      this.options(llngOptions).llng_username_header.toLowerCase();
    const unfoldable = this.unfoldableKeys();
    if (unfoldable) {
      this.logger.error(`${this.name}: ${unfoldable}`);
      res.status(503).json({ error: 'Service Unavailable' });
      return;
    }
    AuthLLNG.dropForgedIdentity(req);
    if (usernameHeader) AuthLLNG.dropForgedIdentity(req, usernameHeader);
    this.handler.run(AuthLLNG.foldedPath(req), res, () => {
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
