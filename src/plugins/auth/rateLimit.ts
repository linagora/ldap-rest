/**
 * @module core/auth/rateLimit
 * Rate limiting plugin to prevent brute-force attacks
 *
 * This plugin adds rate limiting middleware specifically for authentication
 * to protect against brute-force attacks. It should be loaded BEFORE auth plugins.
 *
 * Uses an Express middleware to check rate limits before processing, and
 * an afterAuth hook to track failed authentication attempts.
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express, Request, Response, NextFunction } from 'express';

import DmPlugin from '../../abstract/plugin';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export default class RateLimit extends DmPlugin {
  name = 'rateLimit';
  private store: Map<string, RateLimitEntry> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);
    this.windowMs = this.config.rate_limit_window_ms || 15 * 60 * 1000; // 15 minutes
    this.maxRequests = this.config.rate_limit_max || 100; // 100 requests per window

    this.logger.info(
      `Auth rate limiting enabled: ${this.maxRequests} failed attempts per ${this.windowMs / 1000} seconds`
    );
  }

  api(app: Express): void {
    // Middleware to check rate limits and track failed authentications
    app.use((req: Request, res: Response, next: NextFunction) => {
      const ip = this.getClientIp(req);
      const now = Date.now();
      const entry = this.store.get(ip);

      // Clean up expired entries
      if (entry && now > entry.resetTime) {
        this.store.delete(ip);
      }

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

      // Intercept res.status to track failed auth attempts
      const originalStatus = res.status.bind(res);
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this; // Capture plugin context
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      res.status = function (code: number) {
        if (code === 401 || code === 403) {
          // Track failed authentication
          const entry = self.store.get(ip);
          const now = Date.now();

          if (!entry || now > entry.resetTime) {
            // Create new entry
            self.store.set(ip, {
              count: 1,
              resetTime: now + self.windowMs,
            });
          } else {
            // Increment existing entry
            entry.count++;
          }

          self.logger.debug(
            `Failed auth from ${ip}: ${self.store.get(ip)?.count}/${self.maxRequests}`
          );
        }
        return originalStatus(code);
      };

      next();
    });
  }

  private getClientIp(req: Request): string {
    // Support X-Forwarded-For header for proxied requests
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }
}
