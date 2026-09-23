/**
 * Back-Channel Logout over the shared store.
 *
 * The policy is what lives here now: which keys a token kills, how long a
 * mark is kept, and what a login forgets. Where the marks go is
 * `core/storage`'s business, and this suite uses the file backend so it needs
 * no directory server.
 *
 * The behaviours below are the ones three review rounds settled on the
 * original plugins; the move must not lose any of them.
 */
import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DM } from '../../../src/bin';
import Bcl from '../../../src/plugins/bcl';
import Storage from '../../../src/plugins/storage';
import type { OidcSessionClaims } from '../../../src/hooks';

describe('Back-Channel Logout, over the shared store', function () {
  let server: DM;
  let storage: Storage;
  let bcl: Bcl;
  let dir: string;
  const ISS = 'https://sso.example.com';
  const previous: Record<string, string | undefined> = {};

  const record = async (claims: OidcSessionClaims): Promise<void> =>
    (bcl.hooks.oidclogouttoken as (c: OidcSessionClaims) => Promise<void>)(
      claims
    );
  const login = async (claims: OidcSessionClaims): Promise<void> =>
    (bcl.hooks.oidclogin as (c: OidcSessionClaims) => Promise<void>)(claims);
  const alive = async (claims: OidcSessionClaims): Promise<boolean> => {
    const [, valid] = await (
      bcl.hooks.oidcsessionvalid as (
        a: [OidcSessionClaims, boolean]
      ) => Promise<[OidcSessionClaims, boolean]>
    )([claims, true]);
    return valid;
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bcl-'));
    for (const k of [
      'DM_STORAGE_BACKEND',
      'DM_STORAGE_FILE_DIRECTORY',
      'DM_STORAGE_SWEEP_INTERVAL',
      'DM_BCL_RETENTION',
    ])
      previous[k] = process.env[k];
    process.env.DM_STORAGE_BACKEND = 'file';
    process.env.DM_STORAGE_FILE_DIRECTORY = dir;
    process.env.DM_STORAGE_SWEEP_INTERVAL = '0';
    process.env.DM_BCL_RETENTION = '3600';

    server = new DM();
    await server.ready;
    storage = new Storage(server);
    await server.registerPlugin('storage', storage);
    bcl = new Bcl(server);
    // What `registerPlugin` does, and in its order: the dependency loop
    // first, then `api()`, then the hooks.
    bcl.api();
  });

  after(() => {
    storage?.store.stopSweeping();
    if (storage) Storage.release(storage);
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('should refuse to start without somewhere to keep what it kills', async () => {
    // `requirePlugin` warns and answers null, which is right for a feature
    // that can be skipped. This one cannot: skipping it leaves every session
    // outliving the logout that closed it, and nothing saying so.
    const bare = new DM();
    await bare.ready;
    expect(() => new Bcl(bare).api()).to.throw(/needs core\/storage/);
  });

  it('should find the store although it was built before it', async () => {
    // The refusal above must answer for the configuration, not for the order
    // of two `--plugin` arguments: a plugin is constructed before
    // `registerPlugin` reads its `dependencies` and loads what they name, so
    // `core/bcl` listed first is built with nothing loaded yet. Resolving in
    // the constructor refused that configuration; resolving in `api()`,
    // which runs after the dependency loop, does not.
    const other = new DM();
    await other.ready;
    const early = new Bcl(other);

    // One storage instance at a time is the plugin's own rule, so the
    // suite's hands the guard over for the length of this test. Its store
    // keeps working — `release` clears the guard, not the object.
    Storage.release(storage);
    const late = new Storage(other);
    try {
      await other.registerPlugin('storage', late);
      expect(() => early.api()).to.not.throw();
      await (
        early.hooks.oidclogouttoken as (c: OidcSessionClaims) => Promise<void>
      )({ iss: ISS, sid: 'S7' });
      const [, valid] = await (
        early.hooks.oidcsessionvalid as (
          a: [OidcSessionClaims, boolean]
        ) => Promise<[OidcSessionClaims, boolean]>
      )([{ iss: ISS, sid: 'S7' }, true]);
      expect(
        valid,
        'a plugin built first still records what a token kills'
      ).to.equal(false);
    } finally {
      late.store.stopSweeping();
      Storage.release(late);
    }
  });

  it('should say so rather than answer for a store it never took', async () => {
    // Reading `undefined` as "nothing is recorded" is the fail-open this
    // plugin exists to prevent, so a hook running before `api()` says what
    // is missing.
    const unregistered = new Bcl(server);
    let raised: Error | undefined;
    await (
      unregistered.hooks.oidclogouttoken as (
        c: OidcSessionClaims
      ) => Promise<void>
    )({ iss: ISS, sid: 'S8' }).catch((err: Error) => (raised = err));
    expect(raised?.message).to.match(/before api\(\)/);
  });

  it('should kill the session a token names', async () => {
    await record({ iss: ISS, sid: 'S1' });
    expect(await alive({ iss: ISS, sid: 'S1' })).to.equal(false);
  });

  it('should leave another session alone', async () => {
    expect(await alive({ iss: ISS, sid: 'S2' })).to.equal(true);
  });

  it('should kill every session of a sub when the token names one', async () => {
    await record({ iss: ISS, sub: 'alice' });
    // A session of alice's whose own sid was never named.
    expect(
      await alive({ iss: ISS, sid: 'never-named', sub: 'alice' })
    ).to.equal(false);
  });

  it('should forget what would kill a session just established', async () => {
    await record({ iss: ISS, sid: 'S3', sub: 'bob' });
    expect(
      await alive({ iss: ISS, sid: 'S4', sub: 'bob' }),
      'a new session is dead while the sub mark stands'
    ).to.equal(false);

    await login({ iss: ISS, sid: 'S4', sub: 'bob' });
    expect(
      await alive({ iss: ISS, sid: 'S4', sub: 'bob' }),
      'and alive once login has cleared it'
    ).to.equal(true);
    expect(
      await alive({ iss: ISS, sid: 'S3', sub: 'bob' }),
      'while the session actually logged out stays dead'
    ).to.equal(false);
  });

  it('should stop counting a mark past its retention', async () => {
    // The configuration is read when the server is built, so the environment
    // is the wrong lever here: the retention is changed on the object the
    // plugin reads.
    server.config.bcl_retention = -1;
    const shortLived = new Bcl(server);
    shortLived.api();
    server.config.bcl_retention = 3600;
    await (
      shortLived.hooks.oidclogouttoken as (
        c: OidcSessionClaims
      ) => Promise<void>
    )({ iss: ISS, sid: 'S5' });
    expect(
      await alive({ iss: ISS, sid: 'S5' }),
      'an expired mark must not keep anyone out'
    ).to.equal(true);
  });

  it('should not turn a refusal already given back into an acceptance', async () => {
    const [, valid] = await (
      bcl.hooks.oidcsessionvalid as (
        a: [OidcSessionClaims, boolean]
      ) => Promise<[OidcSessionClaims, boolean]>
    )([{ iss: ISS, sid: 'S2' }, false]);
    expect(valid).to.equal(false);
  });

  it('should take the same token twice without raising', async () => {
    await record({ iss: ISS, sid: 'S6' });
    await record({ iss: ISS, sid: 'S6' });
    expect(await alive({ iss: ISS, sid: 'S6' })).to.equal(false);
  });
});
