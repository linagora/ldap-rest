/**
 * What the server measures of itself, for `core/metrics` to expose; see
 * docs/usage/operations.md#metrics
 * @module lib/metrics
 */
import type { Request } from 'express';
import { Counter, Histogram, Registry } from 'prom-client';

import { extractLdapCode } from './ldapCodes';

/** The instruments below register here; `core/metrics` adds its own */
export const registry = new Registry();

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpRequestDuration = new Histogram({
  name: 'ldap_rest_http_request_duration_seconds',
  help: 'Time to answer a request, by method, route template and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: SECONDS,
  registers: [registry],
});

export type LdapOperation =
  'bind' | 'search' | 'add' | 'modify' | 'rename' | 'delete';

export const ldapOperationDuration = new Histogram({
  name: 'ldap_rest_ldap_operation_duration_seconds',
  help: 'Time the directory takes to answer, by operation and result: ok, the LDAP result code of a refusal, or error when it did not answer',
  labelNames: ['operation', 'result'] as const,
  buckets: SECONDS,
  registers: [registry],
});

export const ldapPoolWait = new Histogram({
  name: 'ldap_rest_ldap_pool_wait_seconds',
  help: 'Time to get a pooled directory connection, opening one included',
  buckets: SECONDS,
  registers: [registry],
});

export const ldapSearchCache = new Counter({
  name: 'ldap_rest_ldap_search_cache_total',
  help: 'Cacheable searches, served by the cache or sent to the directory',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const hookFailures = new Counter({
  name: 'ldap_rest_hook_failures_total',
  help: 'Notification hooks that threw, by hook and plugin',
  labelNames: ['hook', 'plugin'] as const,
  registers: [registry],
});

export const outboundRequestDuration = new Histogram({
  name: 'ldap_rest_outbound_request_duration_seconds',
  help: 'Time a service the server calls takes to answer, by target and status: the HTTP status, or error when it did not answer',
  labelNames: ['target', 'status'] as const,
  buckets: SECONDS,
  registers: [registry],
});

export const unhandledRejections = new Counter({
  name: 'ldap_rest_unhandled_rejections_total',
  help: 'Promise rejections nothing handled',
  registers: [registry],
});

/**
 * The `result` label of a directory call that threw: a refusal is the
 * directory answering, by its result code (32 for an entry that is not
 * there); `error` is for not answering.
 */
export const ldapResult = (err: unknown): string => {
  const code = extractLdapCode(err);
  return code === undefined ? 'error' : String(code);
};

/** @returns the seconds since `started`, a `process.hrtime.bigint()` */
export const secondsSince = (started: bigint): number =>
  Number(process.hrtime.bigint() - started) / 1e9;

/**
 * Time a directory call into the operation histogram, whatever becomes of
 * it.
 */
export async function timedLdap<T>(
  operation: LdapOperation,
  call: () => Promise<T>
): Promise<T> {
  const started = process.hrtime.bigint();
  let result = 'ok';
  try {
    return await call();
  } catch (err) {
    result = ldapResult(err);
    throw err;
  } finally {
    ldapOperationDuration.observe({ operation, result }, secondsSince(started));
  }
}

/**
 * Time a call to another service into the outbound histogram, to its
 * answer's headers: the body is read by the caller, at its own pace.
 */
export async function timedOutbound<T extends { status: number }>(
  target: string,
  call: () => Promise<T>
): Promise<T> {
  const started = process.hrtime.bigint();
  let status = 'error';
  try {
    const res = await call();
    status = String(res.status);
    return res;
  } finally {
    outboundRequestDuration.observe({ target, status }, secondsSince(started));
  }
}

/**
 * The template of the route that answered, never the URL: a label per URL
 * would grow without bound. See docs/usage/operations.md#metrics.
 *
 * @returns the template, `none` when no route matched
 */
export const routeTemplate = (req: Request): string => {
  const route = (req as { route?: { path?: unknown } }).route;
  const path = route?.path;
  const one = (p: unknown): string =>
    typeof p === 'string' ? p : p instanceof RegExp ? p.source : 'other';
  if (path === undefined) return 'none';
  const template = Array.isArray(path) ? path.map(one).join('|') : one(path);
  return `${req.baseUrl ? '*' : ''}${template}`;
};
