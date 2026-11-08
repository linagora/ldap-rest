/**
 * @module core/auth/crowdsec
 * CrowdSec integration plugin to block banned IPs
 *
 * This plugin integrates with CrowdSec Local API to check if incoming
 * requests are from IPs with active ban decisions. It should be loaded
 * BEFORE authentication plugins to block malicious IPs early.
 *
 * Configuration:
 * - crowdsec_url: CrowdSec Local API URL (default: http://localhost:8080)
 * - crowdsec_api_key: API key for bouncer authentication (required)
 * - crowdsec_cache_ttl: Cache TTL in seconds for decisions (default: 60)
 *
 * @author Xavier Guimard <xguimard@linagora.com>
 */
import type { Express, Request, Response, NextFunction } from 'express';

import DmPlugin, { Role } from '../../abstract/plugin.js';

import { crowdsecOptions } from './auth.options.js';

interface CrowdSecDecision {
  duration: string;
  id: number;
  origin: string;
  scenario: string;
  scope: string;
  type: string;
  value: string;
}

interface DecisionCache {
  isBanned: boolean;
  expiresAt: number;
}

export default class CrowdSec extends DmPlugin {
  static optionDefinitions = crowdsecOptions;

  name = 'crowdsec';
  roles: Role[] = ['protect'] as const;
  private apiUrl: string;
  private apiKey: string;
  private cacheTtl: number;
  private cache: Map<string, DecisionCache> = new Map();
  private lastSweep = 0;
  /** Distinct addresses remembered at once, so a rotating header cannot grow the map. */
  private static readonly MAX_CLIENTS = 10000;

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);
    const settings = this.options(crowdsecOptions);
    this.apiUrl = settings.crowdsec_url;
    this.apiKey = settings.crowdsec_api_key;
    this.cacheTtl = settings.crowdsec_cache_ttl;

    if (!this.apiKey) {
      throw new Error(
        'CrowdSec plugin requires crowdsec_api_key configuration'
      );
    }

    this.logger.info(
      `CrowdSec integration enabled with API at ${this.apiUrl} (cache TTL: ${this.cacheTtl}s)`
    );
  }

  api(app: Express): void {
    // Middleware to check IPs against CrowdSec decisions
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      const ip = this.getClientIp(req);

      try {
        const isBanned = await this.checkIpBanned(ip);

        if (isBanned) {
          this.logger.warn(`Blocked request from CrowdSec-banned IP: ${ip}`);
          return res.status(403).json({
            error: 'Access denied',
            reason: 'IP address is banned by security policies',
          });
        }

        next();
      } catch (error) {
        // Log error but don't block request if CrowdSec is unavailable
        this.logger.error(
          `CrowdSec API error for IP ${ip}: ${error instanceof Error ? error.message : String(error)}`
        );
        // Fail open: allow request to proceed if CrowdSec is unavailable
        next();
      }
    });
  }

  private async checkIpBanned(ip: string): Promise<boolean> {
    // Check cache first
    const cached = this.cache.get(ip);
    const now = Date.now();

    if (cached && now < cached.expiresAt) {
      this.logger.debug(`CrowdSec cache hit for IP ${ip}: ${cached.isBanned}`);
      return cached.isBanned;
    }

    // Query CrowdSec API
    const url = `${this.apiUrl}?ip=${encodeURIComponent(ip)}`;
    this.logger.debug(`Querying CrowdSec API: ${url}`);

    const response = await this.fetch(url, {
      headers: {
        'X-Api-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `CrowdSec API returned status ${response.status}: ${response.statusText}`
      );
    }

    // Parse JSON response, handling edge cases
    let data: unknown;
    try {
      const text = await response.text();
      // CrowdSec may return string "null" instead of actual null
      if (text === 'null' || text === '') {
        data = null;
      } else {
        data = JSON.parse(text) as unknown;
      }
    } catch (error) {
      this.logger.error(
        `Failed to parse CrowdSec API response: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new Error(`Invalid JSON response from CrowdSec API`);
    }

    // CrowdSec returns null if no decision, or an array of decisions
    let isBanned = false;
    if (data !== null && Array.isArray(data)) {
      // Check if there's any active ban decision
      isBanned = (data as CrowdSecDecision[]).some(
        decision => decision.type === 'ban'
      );
    }

    // Cache the result
    this.prune(now);
    if (!this.cache.has(ip)) this.evictOldest();
    this.cache.set(ip, {
      isBanned,
      expiresAt: now + this.cacheTtl * 1000,
    });

    this.logger.debug(
      `CrowdSec decision for IP ${ip}: ${isBanned ? 'BANNED' : 'ALLOWED'}`
    );

    return isBanned;
  }

  /** Drop expired decisions, at most once a TTL, and keep the map bounded. */
  private prune(now: number): void {
    if (now - this.lastSweep < this.cacheTtl * 1000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.cache)
      if (now > entry.expiresAt) this.cache.delete(key);
    while (this.cache.size >= CrowdSec.MAX_CLIENTS) this.evictOldest();
  }

  /** Drop the oldest decision: `Map` keeps insertion order. */
  private evictOldest(): void {
    const oldest = this.cache.keys().next().value;
    if (oldest !== undefined) this.cache.delete(oldest);
  }

  private getClientIp(req: Request): string {
    // `trustedProxy` reads the chain and publishes the client it trusts;
    // without it the peer is the client.
    return req.clientIp || req.socket.remoteAddress || 'unknown';
  }
}
