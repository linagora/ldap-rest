/**
 * @module core/helloworld
 * Demo plugin, add /hello API + consumes 'hello' hook
 * @author Xavier Guimard <xguimard@linagora.com>
 */

import type { Express, Request, Response } from 'express';

import DmPlugin from '../../abstract/plugin';

export default class HelloWorld extends DmPlugin {
  name = 'hello';

  api(app: Express): void {
    app.get(
      `${this.config.api_prefix}/hello`,
      async (req: Request, res: Response) => {
        const response = { message: 'Hello', hookResults: [] as unknown[] };
        if (this.server.hooks && this.server.hooks['hello']) {
          for (const hook of this.server.hooks['hello']) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            response.hookResults.push(await hook());
          }
        }
        res.json(response);
      }
    );
  }
}
