import type { Express } from 'express';

import DmPlugin from '../abstract/plugin';

export default class WebLogs extends DmPlugin {
  name = 'weblogs';
  api(app: Express): void {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        this.logger.info({
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration,
        });
      });
      next();
    });
  }
}
