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
 * @module lib/apiFallback
 */
import type { Express, NextFunction, Request, Response } from 'express';

import { errorResponse } from './expressFormatedResponses.js';

/** The parts of Express's router this reads, which its types do not show */
interface RouteLayer {
  route?: {
    methods: Record<string, boolean>;
    _methods(): string[];
  };
  match(path: string): boolean;
}
interface AppInternal {
  handle(req: Request, res: Response, callback?: NextFunction): void;
  router?: { stack: RouteLayer[] };
}

/** The path of a request URL, query left out, as the router reads it */
const pathOf = (url: string): string => {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
};

/** Whether `path` is under `prefix`, the prefix itself included */
export const underPrefix = (path: string, prefix: string): boolean =>
  prefix === '' ||
  prefix === '/' ||
  path === prefix ||
  path.startsWith(`${prefix}/`);

/**
 * The methods the routes matching `path` serve, HEAD with GET as Express
 * adds it. Matching a layer stores what it matched on it, which the router
 * does itself for every request and reads back at once: nothing is left for
 * another request to read.
 */
export function allowedMethods(app: Express, path: string): string[] {
  const stack = (app as unknown as AppInternal).router?.stack ?? [];
  const methods = new Set<string>();
  for (const layer of stack) {
    if (!layer.route || !layer.match(path)) continue;
    for (const method of layer.route._methods())
      if (method !== '_ALL') methods.add(method);
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
  (app: Express, req: Request, res: Response, debug: () => boolean) =>
  (err?: unknown): void => {
    if (res.headersSent) {
      // Too late for an answer of our own: what was sent cannot be fixed
      req.socket.destroy();
      return;
    }
    if (err && err !== 'route' && err !== 'router') {
      const { status, body } = errorResponse(err, debug());
      res.status(status).json(body);
      return;
    }
    const allowed = allowedMethods(app, pathOf(req.url));
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
 */
export function installApiFallback(
  app: Express,
  prefix: () => string,
  debug: () => boolean
): void {
  const internal = app as unknown as AppInternal;
  const handle = internal.handle.bind(app);
  internal.handle = (req, res, callback) =>
    handle(
      req,
      res,
      callback ??
        (underPrefix(pathOf(req.url), prefix())
          ? apiFallback(app, req, res, debug)
          : undefined)
    );
}
