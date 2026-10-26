import type { Express, Request, Response } from 'express';

import type { MaybePromise } from '../hooks';

/** What a plugin answers about the resources it depends on */
export type HealthStatus = 'ok' | 'degraded';

/** The paths of the two probes, served before authentication */
export const HEALTH_PATHS = ['/healthz', '/readyz'] as const;

/** How long one directory probe answers for */
export const LDAP_PROBE_TTL_MS = 5_000;

/** What the readiness probe reads of the server */
export interface Probed {
  /** Every plugin loaded and the composition checked */
  readonly composed: boolean;
  readonly config: { ldap_base?: string };
  readonly ldap: {
    readonly system: {
      search: (
        options: { paged: false; scope: 'base'; attributes: string[] },
        base: string
      ) => Promise<unknown>;
    };
  };
  readonly loadedPlugins: {
    [name: string]: { health?: () => MaybePromise<HealthStatus> };
  };
}

export interface Readiness {
  /** `starting` and `unavailable` answer 503, the two others 200 */
  status: 'starting' | 'ok' | 'degraded' | 'unavailable';
  ldap?: 'ok' | 'failed';
  /** The plugins implementing `health()`; `failed` when it threw */
  plugins?: { [name: string]: HealthStatus | 'failed' };
}

/** The last directory probe of each server: its moment and its answer */
const probes = new WeakMap<Probed, { at: number; ok: boolean }>();

/**
 * Whether the directory answers a base search of the root entry, asked as
 * the server. One answer serves `LDAP_PROBE_TTL_MS`: a probe every few
 * seconds from every replica must not become a load on the directory.
 */
async function directoryAnswers(server: Probed, now: number): Promise<boolean> {
  const last = probes.get(server);
  if (last && now - last.at < LDAP_PROBE_TTL_MS) return last.ok;
  let ok: boolean;
  try {
    await server.ldap.system.search(
      { paged: false, scope: 'base', attributes: ['1.1'] },
      server.config.ldap_base ?? ''
    );
    ok = true;
  } catch {
    ok = false;
  }
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
 */
export async function readiness(
  server: Probed,
  now = Date.now()
): Promise<Readiness> {
  if (!server.composed) return { status: 'starting' };
  if (!(await directoryAnswers(server, now)))
    return { status: 'unavailable', ldap: 'failed' };
  const plugins: NonNullable<Readiness['plugins']> = {};
  for (const [name, plugin] of Object.entries(server.loadedPlugins)) {
    if (!plugin.health) continue;
    try {
      plugins[name] = await plugin.health();
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
