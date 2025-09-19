import type { Express, Request, Response } from 'express';

import { type DM } from '../bin';

let server: DM;

const api = (app: Express, caller: DM): void => {
  console.debug('Hello plugin loaded - routes: GET /hello');
  server = caller;
  console.debug(' => I stored caller object to have hooks later');
  app.get('/hello', (req: Request, res: Response) => {
    const response = { message: 'Hello', hookResults: [] as unknown[] };
    if (server.hooks && server.hooks['hello']) {
      for (const hook of server.hooks['hello']) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        response.hookResults.push(hook());
      }
    }
    res.json(response);
  });
};

export { api };
