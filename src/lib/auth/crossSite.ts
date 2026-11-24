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
 * Refuse, at startup, a value that is not a URL — or, with `bare`, not an
 * origin: a scheme, a host and a port, with no user, path, query or
 * fragment, so that the value means what the server compares.
 *
 * @param values the configured values
 * @param who the plugin asking, for the message
 * @param option the option they come from, for the message
 * @param bare whether each value must be an origin alone
 * @throws Error naming the first value refused
 */
export function assertOrigins(
  values: readonly unknown[],
  who: string,
  option: string,
  bare = false
): void {
  for (const value of values) {
    let url: URL;
    try {
      if (typeof value !== 'string') throw new TypeError();
      url = new URL(value);
    } catch {
      throw new Error(
        `${who}: ${option} holds ${JSON.stringify(value)}, which is not a URL`
      );
    }
    if (bare && url.href !== `${url.origin}/`)
      throw new Error(
        `${who}: ${option} holds ${JSON.stringify(value)}, which is not an ` +
          'origin: write the scheme, the host and the port only, as in ' +
          '"https://console.example.com"'
      );
  }
}

/**
 * The origins of a list of URLs, without duplicates.
 *
 * @param values URLs the caller checked at startup with `assertOrigins`, or
 *               empty strings for unset options
 * @returns their origins
 */
export function originsOf(values: readonly string[]): string[] {
  return [
    ...new Set(values.filter(Boolean).map(value => new URL(value).origin)),
  ];
}

/**
 * Whether a browser reports the request as coming from another site than
 * the trusted origins.
 *
 * `Sec-Fetch-Site: same-origin` or `none` settles it. Otherwise every
 * `Origin` and `Referer` the browser sent must name a trusted origin — a
 * link carries no `Origin`, so `Referer` alone decides then — which tells a
 * console served from a trusted origin apart from any other page, a sibling
 * subdomain included. A value that is not a URL, `Origin: null` among them
 * (a sandboxed frame, a redirect across origins), is another site. A client
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
  let seen = false;
  for (const name of ['origin', 'referer'] as const) {
    const value = req.headers[name];
    if (typeof value !== 'string') continue;
    seen = true;
    try {
      if (!trusted.includes(new URL(value).origin)) return true;
    } catch {
      return true;
    }
  }
  return !seen && typeof site === 'string';
}
