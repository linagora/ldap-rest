import type { Express, Request, Response } from 'express';

import type { MaybePromise } from '../hooks';

/** What a plugin answers about the resources it depends on */
export type HealthStatus = 'ok' | 'degraded';

/** The paths of the two probes, served before authentication */
export const HEALTH_PATHS = ['/healthz', '/readyz'] as const;

/** How long one readiness answer serves */
export const PROBE_TTL_MS = 5_000;

/**
 * How long a readiness answer may take, the directory and every plugin
 * asked at once: under the 3 s a kubelet waits, so that a hanging resource
 * is reported, not timed out
 */
export const PROBE_TIMEOUT_MS = 2_000;

/** What the readiness probe reads of the server */
export interface Probed {
  /** Every plugin loaded and the composition checked */
  readonly composed: boolean;
  /** Told to stop: what is in flight finishes, nothing new is taken */
  readonly stopping: boolean;
  readonly ldap: { ping: (timeoutMs: number) => Promise<void> };
  readonly loadedPlugins: {
    [name: string]: { health?: () => MaybePromise<HealthStatus> };
  };
}

export interface Readiness {
  /** `starting`, `stopping` and `unavailable` answer 503, the two others 200 */
  status: 'starting' | 'stopping' | 'ok' | 'degraded' | 'unavailable';
  ldap?: 'ok' | 'failed';
  /** The plugins implementing `health()`; `failed` when it threw or hung */
  plugins?: { [name: string]: HealthStatus | 'failed' };
}

/** The last answer of each server: its moment and the answer, maybe pending */
const answers = new WeakMap<
  Probed,
  { at: number; answer: Promise<Readiness> }
>();

/** Rejects once `ms` have passed without an answer */
const withTimeout = async <T>(answer: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
};

/** The directory and every plugin asked at once, each within `timeoutMs` */
async function probe(server: Probed, timeoutMs: number): Promise<Readiness> {
  // The client bounds its own socket; the race bounds a ping that does not
  const directory = withTimeout(server.ldap.ping(timeoutMs), timeoutMs).then(
    () => true,
    () => false
  );
  const reports = Object.entries(server.loadedPlugins)
    .filter(([, plugin]) => plugin.health)
    .map(async ([name, plugin]): Promise<[string, HealthStatus | 'failed']> => {
      try {
        const status = await withTimeout(
          Promise.resolve(plugin.health!()),
          timeoutMs
        );
        return [name, status];
      } catch {
        return [name, 'failed'];
      }
    });
  const [ok, results] = await Promise.all([directory, Promise.all(reports)]);
  if (!ok) return { status: 'unavailable', ldap: 'failed' };
  const plugins: NonNullable<Readiness['plugins']> = {};
  for (const [name, status] of results) plugins[name] = status;
  const degraded = Object.values(plugins).some(status => status !== 'ok');
  return { status: degraded ? 'degraded' : 'ok', ldap: 'ok', plugins };
}

/**
 * Tell whether the server can serve: loaded, with a directory that answers.
 * A plugin's resource being down degrades the answer without failing it,
 * so that one broken outbound service does not take every replica out of
 * rotation.
 *
 * One answer serves `PROBE_TTL_MS`, and the probes arriving while it is
 * made share it: a probe every few seconds from every replica, or a flood
 * on an unauthenticated route, must not become a load on the directory nor
 * on what the plugins ask.
 *
 * @param server what is probed
 * @param now the moment, for the answer's age
 * @param timeoutMs how long the whole answer may take
 */
export function readiness(
  server: Probed,
  now = Date.now(),
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<Readiness> {
  // Before the cached answer: a replica leaving says so at once
  if (server.stopping) return Promise.resolve({ status: 'stopping' });
  if (!server.composed) return Promise.resolve({ status: 'starting' });
  const last = answers.get(server);
  // A clock stepping back would keep an answer for the whole step
  if (last && now >= last.at && now - last.at < PROBE_TTL_MS)
    return last.answer;
  const answer = probe(server, timeoutMs);
  answers.set(server, { at: now, answer });
  return answer;
}

/**
 * Serve `GET /healthz`, which answers as long as the process serves, and
 * `GET /readyz`, which answers 200 when `readiness` says the server can
 * serve. Both are outside the API prefix and carry no identity.
 *
 * @param app the application, before its authentication
 * @param server what the readiness probe reads
 */
export function mountHealth(app: Express, server: Probed): void {
  const [live, ready] = HEALTH_PATHS;
  app.get(live, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.get(ready, async (_req: Request, res: Response) => {
    const answer = await readiness(server);
    res.setHeader('Cache-Control', 'no-store');
    const serving = answer.status === 'ok' || answer.status === 'degraded';
    res.status(serving ? 200 : 503).json(answer);
  });
}
