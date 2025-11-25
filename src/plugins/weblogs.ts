import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role } from '../abstract/plugin';
import { DmRequest } from '../lib/auth/base';

export default class WebLogs extends DmPlugin {
  name = 'weblogs';
  roles: Role[] = ['logging'] as const;
  api(app: Express): void {
    app.use((req: DmRequest, res, next) => {
      let nd = true;
      this.logger.debug(`Incoming request: ${req.method} ${req.originalUrl}`);
      const start = Date.now();
      res.on('finish', () => {
        const log: Record<string, string | number> = {};
        // Use proxyAuthUser (from trusted proxy) if available, otherwise use authenticated user
        if (req.proxyAuthUser) {
          log.user = req.proxyAuthUser;
        } else if (req.user) {
          log.user = req.user;
        }
        if (nd) this.log(req, res, start, log);
        nd = false;
      });
      res.on('error', err => {
        if (nd) this.log(req, res, start, { error: err.message });
        nd = false;
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          if (nd)
            this.log(req, res, start, {
              error: `Connection closed before response was sent for ${req.method} ${req.originalUrl}`,
            });
          nd = false;
        }
      });
      next();
    });
  }

  log(
    req: Request,
    res: Response,
    start: number,
    log: Record<string, string | number>
  ): void {
    const duration = Date.now() - start;
    const _log = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      ip: this.getClientIp(req),
      ...log,
    };
    this.logger.notice(_log);
  }

  private getClientIp(req: Request): string {
    // Use X-Forwarded-For if available (already sanitized by trustedProxy plugin)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      // Take the first IP (original client) from the chain
      return forwardedStr.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }
}
