import type { Express } from 'express';

import DmPlugin from '../abstract/plugin';

export default class WebLogs extends DmPlugin {
  name = 'weblogs';
  api(app: Express): void {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        const log = {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration,
        };
        // @ts-expect-error new property set by auth plugins
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        if (res.user) log.user = res.user;
        this.logger.info(log);
      });
      next();
    });
  }
}
