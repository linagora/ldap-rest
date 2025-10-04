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
import fetch from 'node-fetch';

import DmPlugin from '../../abstract/plugin';

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
  name = 'crowdsec';
  private apiUrl: string;
  private apiKey: string;
  private cacheTtl: number;
  private cache: Map<string, DecisionCache> = new Map();

  constructor(...args: ConstructorParameters<typeof DmPlugin>) {
    super(...args);
    this.apiUrl =
      this.config.crowdsec_url || 'http://localhost:8080/v1/decisions';
    this.apiKey = this.config.crowdsec_api_key as string;
    this.cacheTtl = (this.config.crowdsec_cache_ttl as number) || 60;

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

    const response = await fetch(url, {
      headers: {
        'X-Api-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `CrowdSec API returned status ${response.status}: ${response.statusText}`
      );
    }

    const data = await response.json();

    // CrowdSec returns null if no decision, or an array of decisions
    let isBanned = false;
    if (data !== null && Array.isArray(data)) {
      // Check if there's any active ban decision
      isBanned = (data as CrowdSecDecision[]).some(
        decision => decision.type === 'ban'
      );
    }

    // Cache the result
    this.cache.set(ip, {
      isBanned,
      expiresAt: now + this.cacheTtl * 1000,
    });

    this.logger.debug(
      `CrowdSec decision for IP ${ip}: ${isBanned ? 'BANNED' : 'ALLOWED'}`
    );

    return isBanned;
  }

  private getClientIp(req: Request): string {
    // Support X-Forwarded-For header for proxied requests
    // The header can be string | string[] | undefined
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      // If it's an array, take the first element, otherwise use the string directly
      const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      // X-Forwarded-For can contain multiple IPs separated by commas (client, proxy1, proxy2...)
      // The first IP is the original client
      return forwardedStr.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }
}
