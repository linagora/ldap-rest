/**
 * `/logout` ends the session at the provider too (RP-Initiated Logout).
 *
 * It used to drop the cookie alone. Every other path requires a session, so
 * the next request went through the provider, which still had its own, and
 * came back logged in without asking anything: the logout did nothing a
 * caller could see.
 */
import { expect } from 'chai';
import nock from 'nock';

import { BASE_URL, build, login } from '../../helpers/oidcProvider';

/** Whether the response expires the session cookie */
const clearsSession = (setCookie: string | string[] | undefined): boolean =>
  ([] as string[])
    .concat(setCookie ?? [])
    .some(c => /^appSession=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));

describe('OpenID Connect, RP-Initiated Logout', function () {
  afterEach(() => nock.cleanAll());

  it('should send the browser to the provider with the id token', async () => {
    const issuer = 'http://rpil.example.test';
    const request = await build(issuer, true);
    const { cookie, idToken } = await login(request, issuer);

    const res = await request.get('/logout').set('Cookie', cookie);

    expect(res.status).to.equal(302);
    const target = new URL(res.headers.location);
    expect(`${target.origin}${target.pathname}`).to.equal(`${issuer}/logout`);
    expect(target.searchParams.get('id_token_hint')).to.equal(idToken);
    // Registering a return at the provider is not asked of anyone.
    expect(target.searchParams.has('post_logout_redirect_uri')).to.equal(false);
    expect(clearsSession(res.headers['set-cookie'])).to.equal(true);
  });

  it('should log out on /logout/ and on HEAD, as a GET route would', async () => {
    const issuer = 'http://rpil-forms.example.test';
    const request = await build(issuer, true);

    for (const res of [
      await request
        .get('/logout/')
        .set('Cookie', (await login(request, issuer)).cookie),
      await request
        .head('/logout')
        .set('Cookie', (await login(request, issuer)).cookie),
    ]) {
      expect(res.status).to.equal(302);
      expect(new URL(res.headers.location).pathname).to.equal('/logout');
      expect(clearsSession(res.headers['set-cookie'])).to.equal(true);
    }
  });

  it('should still reach the provider without a session', async () => {
    const issuer = 'http://rpil-anonymous.example.test';
    const request = await build(issuer, true);

    const res = await request.get('/logout');

    expect(res.status).to.equal(302);
    expect(res.headers.location).to.equal(`${issuer}/logout`);
  });

  it('should end the session here when the provider has no endpoint', async () => {
    const issuer = 'http://no-rpil.example.test';
    const request = await build(issuer, false);
    const { cookie } = await login(request, issuer);

    const res = await request.get('/logout').set('Cookie', cookie);

    expect(res.status).to.equal(302);
    expect(res.headers.location).to.equal(BASE_URL);
    expect(clearsSession(res.headers['set-cookie'])).to.equal(true);
  });

  it('should publish the logout route in /v1/config, whatever the instance is named', async () => {
    const request = await build('http://config.example.test', true, 'oidc');

    const res = await request
      .get('/api/v1/config')
      .set('Accept', 'application/json');

    expect(res.status).to.equal(200);
    expect(res.body.features.openidconnect).to.deep.equal({
      enabled: true,
      endpoints: { logout: '/logout' },
    });
  });
});
