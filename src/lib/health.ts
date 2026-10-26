import type { Express, Request, Response } from 'express';

import type { MaybePromise } from '../hooks';

/** What a plugin answers about the resources it depends on */
export type HealthStatus = 'ok' | 'degraded';

/** The paths of the two probes, served before authentication */
export const HEALTH_PATHS = ['/healthz', '/readyz'] as const;

/** How long one directory probe answers for */
export const LDAP_PROBE_TTL_MS = 5_000;

/**
 * How long the directory and each plugin have to answer: under the 3 s a
 * kubelet waits, so that a hanging resource is reported, not timed out
 */
export const PROBE_TIMEOUT_MS = 2_000;

/** What the readiness probe reads of the server */
export interface Probed {
  /** Every plugin loaded and the composition checked */
  readonly composed: boolean;
  readonly ldap: { ping: () => Promise<void> };
  readonly loadedPlugins: {
    [name: string]: { health?: () => MaybePromise<HealthStatus> };
  };
}

export interface Readiness {
  /** `starting` and `unavailable` answer 503, the two others 200 */
  status: 'starting' | 'ok' | 'degraded' | 'unavailable';
  ldap?: 'ok' | 'failed';
  /** The plugins implementing `health()`; `failed` when it threw or hung */
  plugins?: { [name: string]: HealthStatus | 'failed' };
}

/** The last directory probe of each server: its moment and its answer */
const probes = new WeakMap<Probed, { at: number; ok: Promise<boolean> }>();

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

/**
 * Whether the directory answers, asked as the server. One answer serves
 * `LDAP_PROBE_TTL_MS`, and the probes arriving meanwhile share it: a probe
 * every few seconds from every replica must not become a load on the
 * directory, nor open a connection each while it does not answer.
 */
function directoryAnswers(
  server: Probed,
  now: number,
  timeoutMs: number
): Promise<boolean> {
  const last = probes.get(server);
  if (last && now - last.at < LDAP_PROBE_TTL_MS) return last.ok;
  const ok = withTimeout(server.ldap.ping(), timeoutMs).then(
    () => true,
    () => false
  );
  probes.set(server, { at: now, ok });
  return ok;
}

/**
 * Tell whether the server can serve: loaded, with a directory that answers.
 * A plugin's resource being down degrades the answer without failing it,
 * so that one broken outbound service does not take every replica out of
 * rotation.
 *
 * @param server what is probed
 * @param now the moment, for the directory probe's age
 * @param timeoutMs how long the directory and each plugin may take
 */
export async function readiness(
  server: Probed,
  now = Date.now(),
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<Readiness> {
  if (!server.composed) return { status: 'starting' };
  if (!(await directoryAnswers(server, now, timeoutMs)))
    return { status: 'unavailable', ldap: 'failed' };
  const plugins: NonNullable<Readiness['plugins']> = {};
  for (const [name, plugin] of Object.entries(server.loadedPlugins)) {
    if (!plugin.health) continue;
    try {
      plugins[name] = await withTimeout(
        Promise.resolve(plugin.health()),
        timeoutMs
      );
    } catch {
      plugins[name] = 'failed';
    }
  }
  const degraded = Object.values(plugins).some(status => status !== 'ok');
  return { status: degraded ? 'degraded' : 'ok', ldap: 'ok', plugins };
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
  app.get('/healthz', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req: Request, res: Response) => {
    const answer = await readiness(server);
    res.setHeader('Cache-Control', 'no-store');
    const ready = answer.status === 'ok' || answer.status === 'degraded';
    res.status(ready ? 200 : 503).json(answer);
  });
}
