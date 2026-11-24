/**
 * Refusing the requests a browser makes on behalf of another site, for the
 * authentication plugins whose credential is a cookie. See
 * docs/usage/plugins/auth/README.md#cookie-sessions-and-other-sites.
 */
import type { Request } from 'express';

import type { Config } from '../../config/args.js';

/** The methods a browser may send from another site without changing anything */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a request asks to change something, so that it must come from a
 * trusted origin when a cookie authenticates it.
 *
 * @param req incoming request
 * @returns true for every method but GET, HEAD and OPTIONS
 */
export function changesState(req: Request): boolean {
  return !SAFE_METHODS.has(String(req.method).toUpperCase());
}

/**
 * The origins `--auth-trusted-origin` names, as given: the plugin's
 * overrides may hold a bare string.
 *
 * @param config the plugin's configuration
 * @returns the configured values
 */
export function configuredOrigins(config: Config): string[] {
  const value = config.auth_trusted_origin;
  return Array.isArray(value) ? value : value ? [value] : [];
}

/**
 * Refuse, at startup, a trusted origin that is not a URL.
 *
 * @param values the configured origins
 * @param who the plugin asking, for the message
 * @param option the option they come from, for the message
 * @throws Error naming the first value that is not a URL
 */
export function assertOrigins(
  values: readonly unknown[],
  who: string,
  option: string
): void {
  for (const value of values) {
    try {
      if (typeof value !== 'string') throw new TypeError();
      new URL(value);
    } catch {
      throw new Error(
        `${who}: ${option} holds ${JSON.stringify(value)}, which is not a URL`
      );
    }
  }
}

/**
 * The origins of a list of URLs, without duplicates. A value that is not a
 * URL is left out: the configured ones were checked at startup.
 *
 * @param values URLs, or empty strings for unset options
 * @returns their origins
 */
export function originsOf(values: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // `--base-url` is checked by the plugin's library, if at all
    }
  }
  return [...origins];
}

/**
 * Whether a browser reports the request as coming from another site than
 * the trusted origins.
 *
 * `Sec-Fetch-Site: same-origin` or `none` settles it. Otherwise `Origin`
 * decides when the browser sent one, and `Referer` when it did not — a link
 * carries no `Origin` — so a console served from a trusted origin is told
 * apart from any other page, a sibling subdomain included. `Origin: null`
 * (a sandboxed frame, a redirect across origins) is another site. A client
 * sending none of the three — a script, a server — is not a browser acting
 * for another site, and is let through.
 *
 * @param req incoming request
 * @param trusted the origins a browser may send it from
 * @returns true when the request comes from another site
 */
export function crossSite(req: Request, trusted: readonly string[]): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return false;
  for (const name of ['origin', 'referer'] as const) {
    const value = req.headers[name];
    if (typeof value !== 'string') continue;
    try {
      return !trusted.includes(new URL(value).origin);
    } catch {
      return true;
    }
  }
  return typeof site === 'string';
}
