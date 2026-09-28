/**
 * A session lasts no longer than its access token: renewed with the refresh
 * token, or ended so that the caller goes back through the provider — a
 * browser redirected there, an API client answered 401.
 */
import { expect } from 'chai';
import type { Response } from 'express';
import nock from 'nock';

import type { DM } from '../../../src/bin';
import { build } from '../../helpers/oidcProvider';

/** A route the plugin guards, answering who it found */
const ping = (server: DM): void => {
  server.app.get('/api/admin/ping', (req, res: Response) =>
    res.json({ user: (req as { user?: string }).user })
  );
};

describe('OpenID Connect, access token expiry', function () {
  afterEach(() => nock.cleanAll());

  it('should answer 401 to an API client with no session', async () => {
    const issuer = 'http://renew-nosession.example.test';
    const request = await build(issuer, true, undefined, ping);

    const res = await request
      .get('/api/admin/ping')
      .set('Accept', 'application/json');

    expect(res.status).to.equal(401);
  });
});
