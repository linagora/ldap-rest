import { Express, Request, Response } from 'express';

const api = (app: Express): void => {
  app.get('/hello', (req: Request, res: Response) => {
    res.json({ message: 'Hello' });
  });
  console.debug('Hello plugin loaded - routes: GET /hello');
};

export { api };
