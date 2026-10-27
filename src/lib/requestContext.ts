/**
 * The request a directory operation is made for, and the one a log line is
 * written for
 * @module lib/requestContext
 */
import { AsyncLocalStorage } from 'async_hooks';

import type { Request } from 'express';

/**
 * The authenticated request being served. The authentication dispatcher
 * runs everything downstream of a request it let through inside it, so an
 * operation made while serving it, by whatever plugin, is judged as its
 * caller even when the request was not handed down (#385). A call that
 * forgets the request then fails closed instead of being let through
 * unjudged.
 */
const requests = new AsyncLocalStorage<Request>();

/**
 * Serve a request: what runs inside, synchronously or not, is made for it.
 *
 * @param req the authenticated request
 * @param fn what serves it
 * @returns what `fn` returns
 */
export function runForRequest<T>(req: Request, fn: () => T): T {
  return requests.run(req, fn);
}

/**
 * Run something as the server, outside the request being served: its
 * operations are judged by nobody. What `ldap.system` does.
 *
 * @param fn what to run
 * @returns what it returns
 */
export function outsideRequest<T>(fn: () => T): T {
  return requests.exit(fn);
}

/**
 * The request being served.
 *
 * @returns the request, or undefined outside any, or as the server
 */
export function currentRequest(): Request | undefined {
  return requests.getStore();
}

/** What a log line carries beside what it says */
export interface LogContext {
  /** The request being served */
  requestId?: string;
  /** The plugin whose hook is running */
  plugin?: string;
  /** That hook */
  op?: string;
}

/**
 * Kept apart from the request above: a line written as the server, through
 * `outsideRequest`, is still about the request that made the server act.
 */
const logContexts = new AsyncLocalStorage<LogContext>();

/**
 * Run something that outlives the request being served, a connection
 * opened for the pool or a client kept for the process: its operations are
 * judged by nobody, and what it logs later is nobody's request.
 *
 * @param fn what to run
 * @returns what it returns
 */
export function outsideAnyRequest<T>(fn: () => T): T {
  return requests.exit(() => logContexts.exit(fn));
}

/**
 * Serve a request with its log context: what runs inside, synchronously or
 * not, logs with it.
 *
 * @param context what the lines carry
 * @param fn what serves the request
 * @returns what `fn` returns
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return logContexts.run(context, fn);
}

/**
 * Run a plugin's hook: what it logs names the plugin and the hook, under the
 * request being served.
 *
 * @param plugin the plugin's instance name
 * @param op the hook
 * @param fn the hook's run
 * @returns what `fn` returns
 */
export function runAsPlugin<T>(plugin: string, op: string, fn: () => T): T {
  return logContexts.run({ ...logContexts.getStore(), plugin, op }, fn);
}

/** The log context of the request being served, if any */
export function currentLogContext(): LogContext | undefined {
  return logContexts.getStore();
}
