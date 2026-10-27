/**
 * `/logout` ends the session at the provider too (RP-Initiated Logout).
 *
 * It used to drop the cookie alone. Every other path requires a session, so
 * the next request went through the provider, which still had its own, and
 * came back logged in without asking anything: the logout did nothing a
 * caller could see.
 */
import { expect } from 'chai';
import type { Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';

import type { DM } from '../../../src/bin';
import {
  currentLogContext,
  type LogContext,
} from '../../../src/lib/requestContext';
import { recordHookOwner } from '../../../src/lib/utils';
import Bcl from '../../../src/plugins/bcl';
import Storage from '../../../src/plugins/storage';
import {
  BASE_URL,
  build,
  clearsSession,
  login,
} from '../../helpers/oidcProvider';

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

/**
 * `/logout` ends the session here too, not only the browser's copy.
 *
 * The cookie holds the whole session, so dropping it left any copy of it —
 * a shared computer, a backup of the browser profile, a stolen cookie —
 * working until its tokens expired, and each answer renewed it. The provider
 * tells the other applications through Back-Channel Logout, not the one that
 * asked it to log out, and Dex tells nobody.
 */
describe('OpenID Connect, /logout and a copy of the cookie', function () {
  let dir: string;
  let storage: Storage | undefined;

  /** A provider, a guarded route, and `core/bcl` over a file store */
  const withBcl = async (
    issuer: string
  ): Promise<{ request: Awaited<ReturnType<typeof build>>; server: DM }> => {
    let server: DM | undefined;
    const request = await build(issuer, true, undefined, s => {
      server = s;
      s.app.get('/api/admin/ping', (req, res: Response) =>
        res.json({ user: (req as { user?: string }).user })
      );
    });
    const dm = server as DM;
    dm.config.storage_backend = 'file';
    dm.config.storage_file_directory = dir;
    dm.config.storage_sweep_interval = 0;
    storage = new Storage(dm);
    await dm.registerPlugin('storage', storage);
    await dm.registerPlugin('bcl', new Bcl(dm));
    return { request, server: dm };
  };

  const ping = (
    request: Awaited<ReturnType<typeof build>>,
    cookie: string
  ): Promise<{ status: number }> =>
    request
      .get('/api/admin/ping')
      .set('Cookie', cookie)
      .set('Accept', 'application/json')
      .then(res => res);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oidc-logout-'));
  });

  afterEach(() => {
    nock.cleanAll();
    if (storage) {
      storage.store.stopSweeping();
      Storage.release(storage);
      storage = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('should refuse a copy of the cookie once /logout has ended it', async () => {
    const issuer = 'http://logout-copy.example.test';
    const { request } = await withBcl(issuer);
    const { cookie } = await login(request, issuer);
    expect((await ping(request, cookie)).status).to.equal(200);

    const res = await request.get('/logout').set('Cookie', cookie);
    expect(res.status).to.equal(302);
    expect(clearsSession(res.headers['set-cookie'])).to.equal(true);

    expect((await ping(request, cookie)).status).to.equal(401);
  });

  it('should leave the other sessions of that person alone', async () => {
    // The helper's provider gives both the same `sid` and `sub`: only the id
    // given at login tells them apart.
    const issuer = 'http://logout-other.example.test';
    const { request } = await withBcl(issuer);
    const first = await login(request, issuer);
    const second = await login(request, issuer);

    await request.get('/logout').set('Cookie', first.cookie);

    expect((await ping(request, first.cookie)).status).to.equal(401);
    expect((await ping(request, second.cookie)).status).to.equal(200);
  });

  it('should end a copy taken before the same person logged in again', async () => {
    // The library merges a login over a live session of the same `sub`: a
    // new id there would leave the copy with one `/logout` no longer names.
    const issuer = 'http://logout-relogin.example.test';
    const { request } = await withBcl(issuer);
    const copy = (await login(request, issuer)).cookie;
    const again = (await login(request, issuer, {}, copy)).cookie;
    expect(again).to.match(/appSession=/);

    await request.get('/logout').set('Cookie', again);

    expect((await ping(request, copy)).status).to.equal(401);
  });

  it('should give a new id to a login over a session already ended', async () => {
    const issuer = 'http://logout-dead.example.test';
    const { request } = await withBcl(issuer);
    const dead = (await login(request, issuer)).cookie;
    await request.get('/logout').set('Cookie', dead);

    const fresh = (await login(request, issuer, {}, dead)).cookie;

    expect((await ping(request, fresh)).status).to.equal(200);
  });

  it('should run a logout subscriber under its plugin and hook', async () => {
    const issuer = 'http://logout-named.example.test';
    const { request, server } = await withBcl(issuer);
    const { cookie } = await login(request, issuer);
    let seen: LogContext | undefined;
    const subscriber = (): void => {
      seen = currentLogContext();
    };
    recordHookOwner(subscriber, 'probe', 'oidclogouttoken');
    (server.hooks as unknown as Record<string, unknown[]>).oidclogouttoken = [
      subscriber,
    ];

    await request.get('/logout').set('Cookie', cookie);

    expect(seen?.requestId).to.be.a('string');
    expect([seen?.plugin, seen?.op]).to.deep.equal([
      'probe',
      'oidclogouttoken',
    ]);
  });

  it('should log out all the same when the session cannot be recorded', async () => {
    const issuer = 'http://logout-failing.example.test';
    const { request, server } = await withBcl(issuer);
    const { cookie } = await login(request, issuer);
    const hooks = server.hooks as unknown as Record<string, unknown[]>;
    hooks.oidclogouttoken = [
      () => Promise.reject(new Error('store unreachable')),
    ];

    const res = await request.get('/logout').set('Cookie', cookie);

    expect(res.status).to.equal(302);
    expect(new URL(res.headers.location).pathname).to.equal('/logout');
    expect(clearsSession(res.headers['set-cookie'])).to.equal(true);
  });
});
