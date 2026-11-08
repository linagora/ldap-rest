/**
 * @module core/auth/rateLimit
 * Rate limiting plugin to prevent brute-force attacks
 *
 * This plugin adds rate limiting middleware specifically for authentication
 * to protect against brute-force attacks. It should be loaded BEFORE auth plugins.
 *
 * Uses an Express middleware to check rate limits before processing, and
 * a middleware per request. It describes an `afterAuth` hook tracking failed
 * authentication attempts, which it has never registered — the counting is
 * per request, whatever the request turns out to be.
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express, Request, Response, NextFunction } from 'express';

import DmPlugin, { type Role } from '../../abstract/plugin.js';

import { rateLimitOptions } from './auth.options.js';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export default class RateLimit extends DmPlugin {
  static optionDefinitions = rateLimitOptions;

  name = 'rateLimit';
  roles: Role[] = ['protect'] as const;
  private store: Map<string, RateLimitEntry> = new Map();
  private windowMs: number;
  private maxRequests: number;
  private lastSweep = 0;
  /** Distinct addresses remembered at once, so a rotating header cannot grow the map. */
  private static readonly MAX_CLIENTS = 10000;

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);
    const settings = this.options(rateLimitOptions);
    this.windowMs = settings.rate_limit_window_ms;
    this.maxRequests = settings.rate_limit_max;

    this.logger.info(
      `Auth rate limiting enabled: ${this.maxRequests} failed attempts per ${this.windowMs / 1000} seconds`
    );
  }

  api(app: Express): void {
    // The limiter keys on the client IP `trustedProxy` publishes after
    // reading the proxy chain from the right. Without that plugin the peer is
    // the client, so a header a client writes cannot move the counter.
    if (!this.server.loadedPlugins.trustedProxy)
      this.logger.warn(
        'Auth rate limiting uses the TCP peer as the client address because ' +
          'core/auth/trustedProxy is not loaded: requests through a proxy ' +
          'share one counter. Load core/auth/trustedProxy to key on the ' +
          'client it identifies.'
      );

    // Middleware to check rate limits and track failed authentications
    app.use((req: Request, res: Response, next: NextFunction) => {
      const ip = this.getClientIp(req);
      const now = Date.now();
      this.prune(now);

      // Check if IP is rate limited
      const currentEntry = this.store.get(ip);
      if (
        currentEntry &&
        currentEntry.count >= this.maxRequests &&
        now <= currentEntry.resetTime
      ) {
        this.logger.warn(
          `Rate limiting ${ip}: ${currentEntry.count}/${this.maxRequests} failed attempts`
        );
        return res.status(429).json({
          error: 'Too many authentication attempts, please try again later',
          retryAfter: Math.ceil((currentEntry.resetTime - now) / 1000),
        });
      }

      // Track failed auth attempts using the 'finish' event
      res.on('finish', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          const entry = this.store.get(ip);
          const now = Date.now();

          if (!entry || now > entry.resetTime) {
            // Restarting a counter moves it to the end of the eviction order
            if (entry) this.store.delete(ip);
            this.prune(now);
            if (this.store.size >= RateLimit.MAX_CLIENTS) this.evictOldest();
            this.store.set(ip, {
              count: 1,
              resetTime: now + this.windowMs,
            });
          } else {
            // Increment existing entry
            entry.count++;
          }

          this.logger.debug(
            `Failed auth from ${ip}: ${this.store.get(ip)?.count}/${this.maxRequests}`
          );
        }
      });

      next();
    });
  }

  /** Drop expired counters, at most once a window, and keep the map bounded. */
  private prune(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.store)
      if (now > entry.resetTime) this.store.delete(key);
    while (this.store.size >= RateLimit.MAX_CLIENTS) this.evictOldest();
  }

  /** Drop the oldest counter: `Map` keeps insertion order. */
  private evictOldest(): void {
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) this.store.delete(oldest);
  }

  private getClientIp(req: Request): string {
    // `trustedProxy` reads the chain and publishes the client it trusts;
    // without it the peer is the client.
    return req.clientIp || req.socket.remoteAddress || 'unknown';
  }
}
