/**
 * The answer of a request under the API prefix no route took.
 *
 * Express answers it with an HTML page ("Cannot PUT /api/…"), which a client
 * of a JSON API cannot read. A catch-all middleware cannot fix that: mounted
 * when the plugins are loaded, it sits before any route registered later — a
 * host calling `dm.app.post()` after `ready`, a test calling
 * `plugin.api(app)` — and makes it unreachable.
 *
 * So the answer is given where Express gives its own: the final handler
 * `app.handle` calls once the whole stack let the request through. It is
 * only replaced when nobody passed one — the server's own listener, or a
 * test calling the app directly. An app mounted in a host's app is handed
 * the host's `next`, and the request goes back to the host.
 *
 * The 405 reads the routes registered on the app itself: a path served by a
 * mounted `express.Router()` answers 404 to a method it lacks. It relies on
 * internals of the `router` package (`app.router.stack`, `layer.matchers`,
 * `route._methods()`), checked against express 5.3.0 and router 2.2.0; if
 * one of them changes, the answer falls back to 404 rather than failing.
 *
 * @module lib/apiFallback
 */
import type { Express, NextFunction, Request, Response } from 'express';

import { errorResponse } from './expressFormatedResponses.js';

/** The parts of Express's router this reads, which its types do not show */
interface RouteLayer {
  route?: {
    /** Upper case, with HEAD added for a GET route and `_ALL` for `all()` */
    _methods?(): string[];
  };
  /** The route path compiled by path-to-regexp, one per path it was given */
  matchers?: Array<(path: string) => unknown>;
}
interface AppInternal {
  handle(req: Request, res: Response, callback?: NextFunction): void;
  router?: { stack?: RouteLayer[] };
}

/**
 * The path of a request as the router reads it — query left out, an
 * absolute-form target (`PUT http://host/api/x`, which a proxy may send)
 * read for its path — taken from Express's own `req.path`. Its getter is
 * called on the request before `app.handle` gives it Express's prototype,
 * so the prefix check and the routing read the same string.
 */
const requestPath = (app: Express, req: Request): string => {
  const path: unknown = Reflect.get(app.request, 'path', req);
  return typeof path === 'string' ? path : req.url;
};

/**
 * Whether `path` is under `prefix`, the prefix itself included, ignoring
 * case as the routing does unless told otherwise
 */
export const underPrefix = (
  path: string,
  prefix: string,
  caseSensitive = false
): boolean => {
  if (prefix === '' || prefix === '/') return true;
  if (!caseSensitive) {
    path = path.toLowerCase();
    prefix = prefix.toLowerCase();
  }
  return path === prefix || path.startsWith(`${prefix}/`);
};

/**
 * The methods the routes registered on the app that match `path` serve,
 * HEAD with GET as Express adds it. The layers' compiled matchers are called
 * rather than `layer.match`, which would store what it matched on the
 * layer. A router whose internals moved gives no method, so a 404, and
 * `onDrift` is told why.
 */
export function allowedMethods(
  app: Express,
  path: string,
  onDrift: (why: string) => void = () => undefined
): string[] {
  const methods = new Set<string>();
  try {
    const stack = (app as unknown as AppInternal).router?.stack;
    if (!Array.isArray(stack)) {
      onDrift('app.router.stack is not a list');
      return [];
    }
    for (const { route, matchers } of stack) {
      if (!route) continue; // a middleware, not a route
      if (typeof route._methods !== 'function' || !Array.isArray(matchers)) {
        onDrift('a route layer has no matchers or _methods()');
        continue;
      }
      if (!matchers.some(matches => matches(path))) continue;
      for (const method of route._methods())
        if (method !== '_ALL') methods.add(method);
    }
  } catch (err) {
    onDrift(`reading the routes threw: ${String(err)}`);
    return [];
  }
  return [...methods].sort();
}

/**
 * Answer what reached the end of the stack under the API prefix: a `405`
 * naming the methods in `Allow` when routes serve the path with others
 * (RFC 9110 §15.5.6), a `404` otherwise, and an error nothing handled as
 * the error middleware would. Every answer is JSON. OPTIONS never comes
 * here for a path a route serves: Express answers it with the methods.
 */
const apiFallback =
  (
    app: Express,
    req: Request,
    res: Response,
    debug: () => boolean,
    onDrift: (why: string) => void
  ) =>
  (err?: unknown): void => {
    // A handler that answered and still called `next()`: nothing is left to
    // answer, and the connection stays usable, as finalhandler leaves it
    if (res.writableEnded) return;
    if (res.headersSent) {
      // An answer begun and abandoned cannot be completed or replaced
      req.socket.destroy();
      return;
    }
    if (err) {
      const { status, body } = errorResponse(err, debug());
      res.status(status).json(body);
      return;
    }
    const allowed = allowedMethods(app, req.path, onDrift);
    if (allowed.length > 0) {
      res.setHeader('Allow', allowed.join(', '));
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }
    res.status(404).json({ error: 'Not found' });
  };

/**
 * Give the requests under the API prefix that no route took a JSON answer.
 * Paths outside it keep Express's.
 *
 * @param app the server's Express app
 * @param prefix the API prefix, read at each request: tests change it
 * @param debug whether an unhandled error's answer carries its details
 * @param warn told once if the router's internals are not what this reads,
 *   so an operator learns why the 405s became 404s
 */
export function installApiFallback(
  app: Express,
  prefix: () => string,
  debug: () => boolean,
  warn: (message: string) => void = () => undefined
): void {
  let warned = false;
  const onDrift = (why: string): void => {
    if (warned) return;
    warned = true;
    warn(
      `The API fallback cannot read Express's routes (${why}): a method a ` +
        'path does not take answers 404 instead of 405. See lib/apiFallback.'
    );
  };
  const internal = app as unknown as AppInternal;
  const handle = internal.handle.bind(app);
  internal.handle = (req, res, callback): void =>
    handle(
      req,
      res,
      callback ??
        (underPrefix(
          requestPath(app, req),
          prefix(),
          app.enabled('case sensitive routing')
        )
          ? apiFallback(app, req, res, debug, onDrift)
          : undefined)
    );
}
