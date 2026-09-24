/**
 * What `core/auth/openidconnect` hands to `express-openid-connect`.
 *
 * Enabling `backchannelLogout` without supplying `onLogin` makes the library
 * run its own, which reaches for `backchannelLogout.store` or `session.store`
 * and calls `destroy` on it. Neither exists here — the sessions stay in the
 * cookie on purpose — so every callback threw and **every login answered
 * 500**, with the session cookie already set: authenticated, and stuck on an
 * error page. No suite walked a login, so it passed CI green.
 *
 * This checks the shape of the configuration rather than driving the login,
 * which would need a signed token and a mocked provider: the invariant worth
 * guarding is that the three Back-Channel Logout hooks are all supplied, and
 * that none of them is left to a default reaching for a store.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import OpenIDConnect from '../../../src/plugins/auth/openidconnect';

describe('OpenID Connect, the Back-Channel Logout configuration', function () {
  let server: DM;
  let plugin: OpenIDConnect;
  const previous: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of [
      'DM_OIDC_SERVER',
      'DM_OIDC_CLIENT_ID',
      'DM_OIDC_CLIENT_SECRET',
      'DM_BASE_URL',
    ])
      previous[k] = process.env[k];
    process.env.DM_OIDC_SERVER = 'https://sso.example.com';
    process.env.DM_OIDC_CLIENT_ID = 'test-client';
    process.env.DM_OIDC_CLIENT_SECRET = 'test-secret';
    process.env.DM_BASE_URL = 'https://console.example.com';

    server = new DM();
    await server.ready;
    plugin = new OpenIDConnect(server);
  });

  after(() => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('should supply all three Back-Channel Logout hooks', () => {
    const config = plugin.buildConfig();
    const bcl = config.backchannelLogout as Record<string, unknown>;
    expect(bcl, 'backchannelLogout is enabled').to.be.an('object');
    for (const hook of ['onLogoutToken', 'isLoggedOut', 'onLogin'])
      expect(
        bcl[hook],
        `${hook} must be ours, not the library's default`
      ).to.be.a('function');
  });

  it('should let a store that could not record reach the provider', async () => {
    // `launchHooks` reports and swallows, by contract. Routing the token
    // through it would leave the provider told 204 about a logout nothing
    // kept — the fail-open this feature exists to close. The failure has to
    // come back out of `onLogoutToken` so the library answers 400 and the
    // provider retries.
    const boom = new Error('the store is read-only');
    (server.hooks as Record<string, unknown>).oidclogouttoken = [
      (): never => {
        throw boom;
      },
    ];
    const config = plugin.buildConfig();
    const onLogoutToken = (
      config.backchannelLogout as {
        onLogoutToken: (t: object) => Promise<void>;
      }
    ).onLogoutToken;

    let raised: unknown;
    await onLogoutToken({ iss: 'https://sso.example.com', sid: 'S1' }).catch(
      (e: unknown) => {
        raised = e;
      }
    );
    expect(raised, 'the failure must not be swallowed').to.equal(boom);
    delete (server.hooks as Record<string, unknown>).oidclogouttoken;
  });

  it('should give every backend the token even when one fails', async () => {
    // Two stores may be loaded at once, and nothing orders them. Stopping at
    // the first failure would leave the healthy one with no record: the
    // provider would retry into the same wall, and the session it considers
    // closed would keep working against the store that would have killed it.
    const boom = new Error('the first store is read-only');
    let secondSaw = false;
    (server.hooks as Record<string, unknown>).oidclogouttoken = [
      (): never => {
        throw boom;
      },
      (): void => {
        secondSaw = true;
      },
    ];
    const onLogoutToken = (
      plugin.buildConfig().backchannelLogout as {
        onLogoutToken: (t: object) => Promise<void>;
      }
    ).onLogoutToken;

    let raised: unknown;
    await onLogoutToken({ iss: 'https://sso.example.com', sid: 'S1' }).catch(
      (e: unknown) => {
        raised = e;
      }
    );
    expect(secondSaw, 'the healthy store must still record').to.equal(true);
    expect(raised, 'and the provider must still be told').to.equal(boom);
    delete (server.hooks as Record<string, unknown>).oidclogouttoken;
  });

  it('should refuse the login when a subscriber could not clear its marks', async () => {
    // `bcl` deletes the mark a logout token set on the `sub`, and
    // `oidcsessionvalid` reads that mark without comparing any timestamp: a
    // failure swallowed here returns a login that works to a caller whose
    // next request is already refused. Behind a provider that logs back in
    // on its own, that is a loop of logins and logouts with a single
    // `Hook error` line to explain it.
    const boom = new Error('the store is read-only');
    (server.hooks as Record<string, unknown>).oidclogin = [
      (): never => {
        throw boom;
      },
    ];
    const config = plugin.buildConfig();
    const onLogin = (
      config.backchannelLogout as {
        onLogin: (req: object) => Promise<void>;
      }
    ).onLogin;

    // The library has already filled `req.appSession` when the hook runs,
    // and its `appSession` middleware writes whatever is there into the
    // cookie — the response to this error included.
    const session: Record<string, unknown> = { sid: 'S1', sub: 'alice' };
    let raised: unknown;
    await onLogin({
      oidc: { idTokenClaims: { iss: 'https://sso.example.com', sub: 'alice' } },
      appSession: session,
    }).catch((e: unknown) => {
      raised = e;
    });
    expect(raised, 'the failure must not be swallowed').to.equal(boom);
    expect(
      Object.keys(session),
      'and the refusal must leave nothing for the cookie'
    ).to.deep.equal([]);
    delete (server.hooks as Record<string, unknown>).oidclogin;
  });

  it('should leave the session in place when every subscriber succeeds', async () => {
    (server.hooks as Record<string, unknown>).oidclogin = [
      (): void => undefined,
    ];
    const config = plugin.buildConfig();
    const onLogin = (
      config.backchannelLogout as {
        onLogin: (req: object) => Promise<void>;
      }
    ).onLogin;

    const session: Record<string, unknown> = { sid: 'S1', sub: 'alice' };
    await onLogin({
      oidc: { idTokenClaims: { iss: 'https://sso.example.com', sub: 'alice' } },
      appSession: session,
    });
    expect(
      Object.keys(session),
      'a login that worked keeps its session'
    ).to.deep.equal(['sid', 'sub']);
    delete (server.hooks as Record<string, unknown>).oidclogin;
  });

  it('should give every subscriber the login even when one fails', async () => {
    // Same reason as for a logout token: stopping at the first failure would
    // leave the marks of the other plugins in place, so the session just
    // established would be refused by the store that never got to run.
    const boom = new Error('the first store is read-only');
    let secondSaw = false;
    (server.hooks as Record<string, unknown>).oidclogin = [
      (): never => {
        throw boom;
      },
      (): void => {
        secondSaw = true;
      },
    ];
    const config = plugin.buildConfig();
    const onLogin = (
      config.backchannelLogout as {
        onLogin: (req: object) => Promise<void>;
      }
    ).onLogin;

    let raised: unknown;
    await onLogin({
      oidc: { idTokenClaims: { iss: 'https://sso.example.com', sub: 'alice' } },
    }).catch((e: unknown) => {
      raised = e;
    });
    expect(secondSaw, 'the healthy store must still clear its marks').to.equal(
      true
    );
    expect(raised, 'and the login must still be refused').to.equal(boom);
    delete (server.hooks as Record<string, unknown>).oidclogin;
  });

  it('should configure no store, since sessions stay in the cookie', () => {
    const config = plugin.buildConfig();
    const bcl = config.backchannelLogout as Record<string, unknown>;
    expect(bcl.store, 'a store here would mean storing sessions').to.equal(
      undefined
    );
    expect((config.session as Record<string, unknown>)?.store).to.equal(
      undefined
    );
  });
});
