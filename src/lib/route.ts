/**
 * @module lib/route
 * @author Xavier Guimard <xguimard@linagora.com>
 *
 * One declaration per HTTP route: its input schemas, the handler that
 * receives the checked values, and what the OpenAPI document says of it.
 * @group Libraries
 */
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Express, Request, RequestHandler, Response } from 'express';

import { BadRequestError } from './errors';
import { asyncHandler } from './utils';

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** What the handler receives for a part it declared no schema for. */
type Input<T> = T extends TSchema ? Static<T> : unknown;

/** What a handler receives once its request has been checked. */
export interface RouteInput<
  P extends TSchema | undefined,
  Q extends TSchema | undefined,
  B extends TSchema | undefined,
> {
  req: Request;
  res: Response;
  params: Input<P>;
  query: Input<Q>;
  body: Input<B>;
}

/**
 * An answer: its schema, and the sentence the document gives it. A bare
 * schema is described by its status (`Successful response`, `Bad request`…).
 */
export interface RouteResponse {
  schema: TSchema;
  description?: string;
}

/** A route, as declared and as recorded for the OpenAPI document. */
export interface RouteDefinition<
  P extends TSchema | undefined = undefined,
  Q extends TSchema | undefined = undefined,
  B extends TSchema | undefined = undefined,
> {
  method: RouteMethod;
  path: string;
  /** The path parameters, checked and converted from their string form */
  params?: P;
  /** The query parameters, checked and converted from their string form */
  query?: Q;
  /** The parsed body */
  body?: B;
  /** The answers, for the OpenAPI document */
  responses?: Partial<Record<number, TSchema | RouteResponse>>;
  summary?: string;
  description?: string;
  tags?: string[];
  handler: (input: RouteInput<P, Q, B>) => void | Promise<void>;
}

/** A route recorded on an app, with its schemas kept for the document. */
export type RegisteredRoute = Omit<
  RouteDefinition<TSchema, TSchema, TSchema>,
  'handler'
>;

const registries = new WeakMap<Express, RegisteredRoute[]>();

/**
 * The routes `defineRoute` registered on an app, in declaration order.
 *
 * @param app the express app the plugin was given
 * @returns its routes
 */
export const registeredRoutes = (app: Express): readonly RegisteredRoute[] =>
  registries.get(app) ?? [];

/** A route Express carries, as the stack spells it. */
export interface StackRoute {
  method: string;
  path: string;
}

interface StackLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: StackLayer[] };
}

/**
 * The routes an app carries that `defineRoute` did not declare.
 *
 * The stack is walked at any depth, so a mounted router's routes are seen
 * too. A route is matched on its method and path, which is what the
 * declaration records.
 *
 * @param app the express app
 * @returns the undeclared routes, in stack order
 */
export const unregisteredRoutes = (app: Express): StackRoute[] => {
  const internal = app as unknown as {
    router?: { stack?: StackLayer[] };
    _router?: { stack?: StackLayer[] };
  };
  const declared = new Set(
    registeredRoutes(app).map(
      route => `${route.method.toUpperCase()} ${route.path}`
    )
  );
  const found: StackRoute[] = [];

  const walk = (layers: StackLayer[] | undefined): void => {
    for (const layer of layers ?? []) {
      if (layer.route)
        for (const method of Object.keys(layer.route.methods)) {
          const upper = method.toUpperCase();
          if (!declared.has(`${upper} ${layer.route.path}`))
            found.push({ method: upper, path: layer.route.path });
        }
      else walk(layer.handle?.stack);
    }
  };

  walk((internal.router ?? internal._router)?.stack);
  return found;
};

/** `body.member` rather than `body./member`, and `body` for the whole part */
const label = (part: string, path: string): string =>
  !path || path === '/'
    ? part
    : `${part}.${path.slice(1).replaceAll('/', '.')}`;

/**
 * Check one part of the request against its schema.
 *
 * Path and query values arrive as strings, so they are converted before
 * being checked: `?limit=10` answers a `T.Number`, where the handler would
 * otherwise read `"10"`. The body has already been parsed, and is checked as
 * it came.
 *
 * @param part the name of the part, for the message
 * @param schema its schema
 * @param value what the request carries
 * @param convert whether to convert from the string form first
 * @param invalid collects the failing paths of every part
 * @returns the value the handler receives
 */
const check = <S extends TSchema>(
  part: string,
  schema: S,
  value: unknown,
  convert: boolean,
  invalid: string[]
): unknown => {
  const checked = convert ? Value.Convert(schema, value) : value;
  for (const error of Value.Errors(schema, checked))
    invalid.push(`${label(part, error.path)}: ${error.message}`);
  return checked;
};

/** Register the route on the app, whatever the verb. */
const register = (
  app: Express,
  method: RouteMethod,
  path: string,
  handler: RequestHandler
): void => {
  switch (method) {
    case 'get':
      app.get(path, handler);
      return;
    case 'post':
      app.post(path, handler);
      return;
    case 'put':
      app.put(path, handler);
      return;
    case 'patch':
      app.patch(path, handler);
      return;
    case 'delete':
      app.delete(path, handler);
  }
};

/**
 * Declare an HTTP route.
 *
 * The declared schemas are checked before the handler runs; a request that
 * fails them is a {@link BadRequestError} naming every failing path, so the
 * middleware answers it as any other client error. The handler receives the
 * checked values and answers through `res`, as with `asyncHandler`, whose
 * rejections it still forwards.
 *
 * The declaration is recorded on the app, with its schemas, for the OpenAPI
 * document and for the check that no route escapes it.
 *
 * @param app the express app the plugin was given
 * @param route the declaration
 */
export const defineRoute = <
  P extends TSchema | undefined = undefined,
  Q extends TSchema | undefined = undefined,
  B extends TSchema | undefined = undefined,
>(
  app: Express,
  route: RouteDefinition<P, Q, B>
): void => {
  const handler = asyncHandler(async (req, res) => {
    const invalid: string[] = [];
    const params = route.params
      ? check('params', route.params, req.params, true, invalid)
      : req.params;
    const query = route.query
      ? check('query', route.query, req.query, true, invalid)
      : req.query;
    const body: unknown = route.body
      ? check('body', route.body, req.body, false, invalid)
      : req.body;
    if (invalid.length)
      throw new BadRequestError(`Invalid request: ${invalid.join('; ')}`);

    await route.handler({
      req,
      res,
      params,
      query,
      body,
    } as unknown as RouteInput<P, Q, B>);
  });

  const routes = registries.get(app) ?? [];
  if (!registries.has(app)) registries.set(app, routes);
  routes.push({
    method: route.method,
    path: route.path,
    params: route.params,
    query: route.query,
    body: route.body,
    responses: route.responses,
    summary: route.summary,
    description: route.description,
    tags: route.tags,
  });

  register(app, route.method, route.path, handler);
};
