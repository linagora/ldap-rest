/**
 * What an identity-less request costs the log.
 *
 * `authzPerRoute` passes a request it cannot identify — the anonymous paths
 * it is meant to let through, a login route, a health check — and says so,
 * because that is also what a mistyped `auth_path_prefix` or a missing
 * authentication plugin look like, where every rule is a no-op.
 *
 * Saying it per request made the line the log. Saying it once per route
 * fixed the common case and left the bound on the wrong thing: `req.path`
 * is a concrete path, identifiers included, so a client decides how many
 * distinct ones exist, and a set that stops growing leaves everything it
 * never had room for unseen for ever — one line per request again, exactly
 * when there are many. The bound belongs on the log.
 */
import { expect } from 'chai';
import supertest from 'supertest';
import type { Express, Request, Response } from 'express';

import { DM } from '../../../src/bin';
import DmPlugin from '../../../src/abstract/plugin';
import AuthzPerRoute from '../../../src/plugins/auth/authzPerRoute';

class AnyRoute extends DmPlugin {
  name = 'anyRoute';

  api(app: Express): void {
    app.get('/api/thing/:id', (_req: Request, res: Response) => {
      res.json({ served: true });
    });
  }
}

describe('An identity-less request, and the log it writes', function () {
  const saved = process.env.DM_AUTHZ_PER_ROUTES;
  let server: DM;
  let request: ReturnType<typeof supertest>;
  let warned: number;
  let debugged: number;

  before(async () => {
    process.env.DM_AUTHZ_PER_ROUTES = 'someone:GET:/api/thing';
    server = new DM();
    await server.ready;
    await server.registerPlugin('authzPerRoute', new AuthzPerRoute(server));
    await server.registerPlugin('anyRoute', new AnyRoute(server));
    server.setupErrorMiddleware();
    request = supertest(server.app);

    const realWarn = server.logger.warn.bind(server.logger);
    const realDebug = server.logger.debug.bind(server.logger);
    server.logger.warn = ((message: string) => {
      if (String(message).includes('carries no identity')) warned++;
      return realWarn(message as never);
    }) as unknown as typeof server.logger.warn;
    server.logger.debug = ((message: string) => {
      if (String(message).includes('carries no identity')) debugged++;
      return realDebug(message as never);
    }) as unknown as typeof server.logger.debug;
  });

  after(() => {
    if (saved === undefined) delete process.env.DM_AUTHZ_PER_ROUTES;
    else process.env.DM_AUTHZ_PER_ROUTES = saved;
  });

  beforeEach(() => {
    warned = 0;
    debugged = 0;
  });

  it('should say it once per route, not once per request', async () => {
    for (let i = 0; i < 3; i++) await request.get('/api/thing/1');
    expect(warned, 'warnings').to.equal(1);
    expect(debugged, 'the rest').to.equal(2);
  });

  it('should stop warning once it has written enough of them', async () => {
    // Every path here is new, so the set can never answer "seen": what has
    // to hold is the count of lines written.
    this.timeout(60000);
    for (let i = 0; i < 1100; i++) await request.get(`/api/thing/${i}`);
    // 1000 minus the one the first case already spent on /api/thing/1.
    expect(warned, 'warnings').to.be.at.most(1000);
    expect(debugged, 'the rest').to.be.at.least(100);
  });
});
