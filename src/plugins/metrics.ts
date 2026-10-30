/**
 * Prometheus metrics on a port of their own, see
 * docs/usage/operations.md#metrics
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { Express } from 'express';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

import DmPlugin from '../abstract/plugin';
import type { DM } from '../bin';
import { registry } from '../lib/metrics';

import { metricsOptions } from './metrics.options';

export default class Metrics extends DmPlugin {
  static optionDefinitions = metricsOptions;

  name = 'metrics';
  /** The gauges read at scrape time and the process metrics */
  private readonly own = new Registry();
  private readonly exposed: Registry;
  private listener?: Server;

  constructor(server: DM) {
    super(server);
    collectDefaultMetrics({ register: this.own });
    const pool = new Gauge({
      name: 'ldap_rest_ldap_pool_connections',
      help: 'Pooled directory connections, by state',
      labelNames: ['state'] as const,
      registers: [this.own],
      collect: (): void => {
        const stats = this.server.ldap.poolStats();
        pool.set({ state: 'busy' }, stats.busy);
        pool.set({ state: 'idle' }, stats.idle);
      },
    });
    const waiting = new Gauge({
      name: 'ldap_rest_ldap_pool_waiting',
      help: 'Operations waiting for a pooled directory connection',
      registers: [this.own],
      collect: (): void => {
        waiting.set(this.server.ldap.poolStats().waiting);
      },
    });
    const opening = new Gauge({
      name: 'ldap_rest_ldap_pool_opening',
      help: 'Directory connections being opened, counted in the pool size',
      registers: [this.own],
      collect: (): void => {
        opening.set(this.server.ldap.poolStats().opening);
      },
    });
    const max = new Gauge({
      name: 'ldap_rest_ldap_pool_max',
      help: 'Pooled directory connections at most, --ldap-pool-size',
      registers: [this.own],
      collect: (): void => {
        max.set(this.server.ldap.poolStats().max);
      },
    });
    this.exposed = Registry.merge([registry, this.own]);
  }

  /** Open the listener; the server does not start on a port it cannot take */
  async api(_app: Express): Promise<void> {
    const listener = createServer((req, res) => void this.answer(req, res));
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(this.options(metricsOptions).metrics_port, () => {
        listener.off('error', reject);
        resolve();
      });
    });
    this.listener = listener;
    this.logger.notice(`Metrics served on port ${this.port() as number}`);
  }

  /** @returns the port the metrics are served on, once `api` opened it */
  port(): number | undefined {
    const address = this.listener?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  private async answer(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      const body = await this.exposed.metrics();
      res.setHeader('Content-Type', this.exposed.contentType);
      res.end(body);
    } catch (err) {
      this.logger.warn(
        `Metrics not collected: ${err instanceof Error ? err.message : String(err)}`
      );
      res.statusCode = 500;
      res.end();
    }
  }

  async close(): Promise<void> {
    const listener = this.listener;
    if (!listener) return;
    this.listener = undefined;
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}
