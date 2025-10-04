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
        if (req.user) log.user = req.user;
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
      ...log,
    };
    this.logger.info(_log);
  }
}
