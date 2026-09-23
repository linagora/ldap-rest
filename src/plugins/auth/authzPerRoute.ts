/**
 * @module core/auth/authzPerRoute
 * Route-level authorization plugin.
 *
 * Restricts access by HTTP method + path based on the authenticated user name
 * (req.user, set by an auth plugin loaded before this one).
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express, Request, Response, NextFunction } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin';
import { forbidden } from '../../lib/expressFormatedResponses';
import {
  assertIdentityMode,
  identityFor,
  warnUnmatchedRuleKeys,
  type DmRequest,
} from '../../lib/auth/base';

// Whitelist of characters permitted in a glob pattern.
// Covers all characters needed for typical REST paths: alphanumerics, slash,
// underscore, hyphen, dot, plus, and the glob wildcards (*).
// Any pattern containing characters outside this set is rejected.
const ALLOWED_GLOB_CHARS = /^[\w/.\-+*]*$/;

// Convert a glob pattern to a RegExp. '*' matches one path segment ([^/]*),
// '**' matches any sequence including '/' (.*). All other characters are escaped.
//
// Security: the pattern is validated against ALLOWED_GLOB_CHARS before any
// regex construction, providing a whitelist guard recognised by CodeQL's
// js/regex-injection query. Only the sanitised, escaped string flows into
// new RegExp.
//
// Throws if the glob contains characters outside the allowed set.
export function globToRegex(glob: string): RegExp {
  if (!ALLOWED_GLOB_CHARS.test(glob)) {
    throw new Error(
      `Invalid glob pattern: "${glob}" — only [a-zA-Z0-9_/.+*-] are allowed`
    );
  }
  // Escape every regex-significant character first (producing a safe string).
  // Among the whitelisted chars only `.` and `+` are regex metacharacters;
  // `*` is also flagged by the broad escape set and will be escaped too.
  const escaped = glob.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  // After escaping: `**` → `\*\*`, `*` → `\*`.
  // Restore glob semantics on the already-sanitised string.
  const pattern = escaped.replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${pattern}$`);
}

interface WildcardRule {
  kind: 'wildcard';
}

interface MethodPathRule {
  kind: 'method-path';
  method: string; // uppercase HTTP verb or '*'
  pathRe: RegExp;
}

type AuthzRule = WildcardRule | MethodPathRule;

export default class AuthzPerRoute extends DmPlugin {
  name = 'authzPerRoute';
  roles: Role[] = ['authz'] as const;
  private rules: Map<string, AuthzRule[]> = new Map();

  /** Said once: a rule keyed on a value the authenticator did not publish. */
  private fallbackWarned = false;
  /** Routes already reported as reached with no identity. */
  private unidentifiedRoutes = new Set<string>();
  /** How many such lines have been written at `warn`. */
  private unidentifiedWarnings = 0;
  /**
   * How many of those lines to write, and how many routes to remember.
   *
   * The bound that matters is on the *log*, not on the set: `req.path` is a
   * concrete path, identifiers included, so a client decides how many
   * distinct ones exist. Bounding only the set leaves every path it never
   * had room for unseen for ever, and each request for one writes the line
   * again — the bound holds the memory and loses the thing it was there to
   * protect.
   */
  private static readonly UNIDENTIFIED_MAX = 1000;

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);
    assertIdentityMode(this.config, this.constructor.name);

    const entries = this.config.authz_per_route ?? [];
    for (const entry of entries) {
      this.parseEntry(entry);
    }

    const summary = [...this.rules.entries()]
      .map(([user, rules]) => {
        const hasWildcard = rules.some(r => r.kind === 'wildcard');
        return `${user}: ${hasWildcard ? 'full access' : `${rules.length} rule${rules.length !== 1 ? 's' : ''}`}`;
      })
      .join(', ');

    this.logger.info(
      `authzPerRoute: ${this.rules.size} user${this.rules.size !== 1 ? 's' : ''} configured${this.rules.size > 0 ? ` (${summary})` : ''}`
    );
  }

  private parseEntry(entry: string): void {
    const parts = entry.split(':').map(p => p.trim());

    if (parts.length < 2) {
      this.logger.warn(`authzPerRoute: ignoring invalid rule entry: ${entry}`);
      return;
    }

    const user = parts[0];

    if (!user) {
      this.logger.warn(
        `authzPerRoute: ignoring rule with empty user: ${entry}`
      );
      return;
    }

    // "<user>:*" — full wildcard
    if (parts.length === 2 && parts[1] === '*') {
      this.addRule(user, { kind: 'wildcard' });
      return;
    }

    // "<user>:<METHOD>:<pathGlob>"
    if (parts.length >= 3) {
      const method = parts[1].toUpperCase();
      const VALID_METHODS = new Set([
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'PATCH',
        'HEAD',
        'OPTIONS',
        '*',
      ]);
      if (!method || !VALID_METHODS.has(method)) {
        this.logger.warn(
          `authzPerRoute: ignoring rule with invalid method "${parts[1]}" in entry: ${entry}`
        );
        return;
      }
      // Rejoin in case the glob itself contains colons, then trim
      const pathPattern = parts.slice(2).join(':').trim();
      if (!pathPattern) {
        this.logger.warn(
          `authzPerRoute: ignoring rule with empty path pattern in entry: ${entry}`
        );
        return;
      }
      let pathRe: RegExp;
      try {
        pathRe = globToRegex(pathPattern);
      } catch {
        this.logger.warn(
          `authzPerRoute: ignoring entry with invalid glob "${pathPattern}" in rule: ${entry}`
        );
        return;
      }
      this.addRule(user, { kind: 'method-path', method, pathRe });
      return;
    }

    this.logger.warn(`authzPerRoute: ignoring invalid rule entry: ${entry}`);
  }

  private addRule(user: string, rule: AuthzRule): void {
    const existing = this.rules.get(user);
    if (existing) {
      existing.push(rule);
    } else {
      this.rules.set(user, [rule]);
    }
  }

  private matches(rules: AuthzRule[], method: string, path: string): boolean {
    for (const rule of rules) {
      if (rule.kind === 'wildcard') return true;
      if (
        (rule.method === '*' || rule.method === method.toUpperCase()) &&
        rule.pathRe.test(path)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Say, once every plugin is loaded, when no rule can ever match.
   *
   * The rules are keyed on identities, and which values an authenticator
   * publishes is the whole subject of #187: a rule written for a token name
   * is inert behind OpenID Connect, where the identity is a `sub`. Inert is
   * the part worth a line — nothing is refused, so nothing looks wrong.
   */
  afterLoad(): void {
    warnUnmatchedRuleKeys(
      [...this.rules.keys()],
      this.server.loadedPlugins,
      this.name,
      this.logger
    );
  }

  api(app: Express): void {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const { value: user, fellBack } = identityFor(
        req as DmRequest,
        this.config
      );
      if (fellBack && !this.fallbackWarned) {
        this.fallbackWarned = true;
        this.logger.warn(
          `${this.name}: --authz-identity asks for req.userName and the ` +
            'authenticator published none, so rules are matched against ' +
            'req.user instead'
        );
      }

      // No authenticated user yet — let upstream auth plugin handle 401
      if (!user) {
        // Said once per route, not once per request. This is right for the
        // anonymous paths the documentation describes — and for a login
        // route, and for a health check, which is most of the traffic that
        // reaches here without an identity; a line per request would be the
        // log rather than a signal. It is also what a mistyped prefix or a
        // missing authentication plugin look like, where every rule is a
        // no-op, so the first time each route is reached that way is worth
        // a line.
        const route = `${req.method} ${req.path}`;
        const line =
          `${this.name}: ${route} carries no identity, so no route rule ` +
          'applies to it';
        const seen = this.unidentifiedRoutes.has(route);
        if (
          !seen &&
          this.unidentifiedWarnings < AuthzPerRoute.UNIDENTIFIED_MAX
        ) {
          this.unidentifiedWarnings++;
          this.unidentifiedRoutes.add(route);
          this.logger.warn(line);
        } else {
          this.logger.debug(line);
        }
        return next();
      }

      const rules = this.rules.get(user);
      if (!rules) {
        this.logger.warn(
          `authzPerRoute: user '${user}' denied for ${req.method} ${req.path} (no rules configured)`
        );
        return forbidden(res);
      }

      if (this.matches(rules, req.method, req.path)) {
        return next();
      }

      this.logger.warn(
        `authzPerRoute: user '${user}' denied for ${req.method} ${req.path}`
      );
      return forbidden(res);
    });
  }
}
