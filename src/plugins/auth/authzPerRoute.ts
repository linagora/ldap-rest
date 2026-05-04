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
import type { DmRequest } from '../../lib/auth/base';

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
    throw new Error(`Invalid glob pattern: "${glob}" — only [a-zA-Z0-9_/.\-+*] are allowed`);
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

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);

    const entries = (this.config.authz_per_route as string[] | undefined) ?? [];
    for (const entry of entries) {
      this.parseEntry(entry);
    }

    const summary = [...this.rules.entries()]
      .map(([user, rules]) => {
        const hasWildcard = rules.some((r) => r.kind === 'wildcard');
        return `${user}: ${hasWildcard ? 'full access' : `${rules.length} rule${rules.length !== 1 ? 's' : ''}`}`;
      })
      .join(', ');

    this.logger.info(
      `authzPerRoute: ${this.rules.size} user${this.rules.size !== 1 ? 's' : ''} configured${this.rules.size > 0 ? ` (${summary})` : ''}`
    );
  }

  private parseEntry(entry: string): void {
    const parts = entry.split(':');

    if (parts.length < 2) {
      this.logger.warn(`authzPerRoute: ignoring invalid rule entry: ${entry}`);
      return;
    }

    const user = parts[0];

    // "<user>:*" — full wildcard
    if (parts.length === 2 && parts[1] === '*') {
      this.addRule(user, { kind: 'wildcard' });
      return;
    }

    // "<user>:<METHOD>:<pathGlob>"
    if (parts.length >= 3) {
      const method = parts[1].toUpperCase();
      // Rejoin in case the glob itself contains colons
      const pathPattern = parts.slice(2).join(':');
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

  api(app: Express): void {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const user = (req as DmRequest).user;

      // No authenticated user yet — let upstream auth plugin handle 401
      if (!user) {
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
