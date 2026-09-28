/**
 * A session lasts no longer than its access token: renewed with the refresh
 * token, or ended so that the caller goes back through the provider — a
 * browser redirected there, an API client answered 401.
 */
import { expect } from 'chai';
import type { Response } from 'express';
import nock from 'nock';

import type { DM } from '../../../src/bin';
import { build, cookies, login } from '../../helpers/oidcProvider';

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

  it('should keep a session whose access token is still valid', async () => {
    const issuer = 'http://renew-valid.example.test';
    const request = await build(issuer, true, undefined, ping);
    const { cookie } = await login(request, issuer, {
      expires_in: 3600,
      refresh_token: 'rt',
    });

    // No token endpoint left in nock: a renewal would fail the request.
    const res = await request
      .get('/api/admin/ping')
      .set('Cookie', cookie)
      .set('Accept', 'application/json');

    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ user: 'alice' });
  });

  it('should renew an expired access token with the refresh token', async () => {
    const issuer = 'http://renew-refresh.example.test';
    const request = await build(issuer, true, undefined, ping);
    const { cookie } = await login(request, issuer, {
      expires_in: 0,
      refresh_token: 'rt',
    });
    let asked: string | undefined;
    const renewal = nock(issuer)
      .post('/token', body => {
        asked = `${body.grant_type}:${body.refresh_token}`;
        return true;
      })
      .reply(200, {
        access_token: 'at2',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    const res = await request
      .get('/api/admin/ping')
      .set('Cookie', cookie)
      .set('Accept', 'application/json');

    expect(res.status).to.equal(200);
    expect(res.body).to.deep.equal({ user: 'alice' });
    expect(renewal.isDone(), 'the token endpoint was asked').to.equal(true);
    expect(asked).to.equal('refresh_token:rt');

    // The renewed token went into the cookie: no second renewal.
    const again = await request
      .get('/api/admin/ping')
      .set('Cookie', cookies(res))
      .set('Accept', 'application/json');
    expect(again.status).to.equal(200);
  });

  it('should end the session when there is no refresh token', async () => {
    const issuer = 'http://renew-none.example.test';
    const request = await build(issuer, true, undefined, ping);
    const { cookie } = await login(request, issuer, { expires_in: 0 });

    const api = await request
      .get('/api/admin/ping')
      .set('Cookie', cookie)
      .set('Accept', 'application/json');
    expect(api.status, 'an API client').to.equal(401);

    const page = await request
      .get('/api/admin/ping')
      .set('Cookie', cookie)
      .set('Accept', 'text/html');
    expect(page.status, 'a browser').to.equal(302);
    expect(new URL(page.headers.location).pathname).to.equal('/authorize');
  });

  it('should end the session when the provider refuses the renewal', async () => {
    const issuer = 'http://renew-refused.example.test';
    const request = await build(issuer, true, undefined, ping);
    const { cookie } = await login(request, issuer, {
      expires_in: 0,
      refresh_token: 'rt',
    });
    nock(issuer).post('/token').reply(400, { error: 'invalid_grant' });

    const res = await request
      .get('/api/admin/ping')
      .set('Cookie', cookie)
      .set('Accept', 'application/json');

    expect(res.status).to.equal(401);
  });
});
