/**
 * Back-Channel Logout tombstones, kept in the directory.
 *
 * Nothing here stores a session: a logout token leaves a mark saying that one
 * `sid`, or every session of one `sub`, is dead, and each request asks
 * whether such a mark exists. Three things have to hold, and the last two are
 * what makes the storage safe to leave running:
 *
 *  - a mark is found again, by `sid` and by `sub`;
 *  - it stops counting once the session it kills would have ended anyway —
 *    enforced on read, because a sweeper running late must never keep out
 *    someone who has since logged in again;
 *  - the sweeper reclaims it.
 */
import { expect } from 'chai';

import { DM } from '../../../src/bin';
import BclLdap from '../../../src/plugins/bcl/ldap';
import type { SearchResult } from '../../../src/lib/ldapActions';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('Back-Channel Logout, tombstones in LDAP', function () {
  let server: DM;
  let plugin: BclLdap;
  let base: string;
  let branch: string;
  const ISS = 'https://sso.example.com';
  let previousBase: string | undefined;
  let previousRetention: string | undefined;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async function () {
    this.timeout(20000);
    base = process.env.DM_LDAP_BASE as string;
    branch = `ou=BclTombstones,${base}`;
    previousBase = process.env.DM_BCL_LDAP_BASE;
    previousRetention = process.env.DM_BCL_RETENTION;
    process.env.DM_BCL_LDAP_BASE = branch;
    process.env.DM_BCL_RETENTION = '3600';

    server = new DM();
    await server.ready;
    await server.ldap
      .add(branch, {
        objectClass: ['top', 'organizationalUnit'],
        ou: 'BclTombstones',
      })
      .catch(() => undefined);
    plugin = new BclLdap(server);
  });

  after(async () => {
    plugin?.store.stopSweeping();
    const res = (await server.ldap
      .search({ paged: false, scope: 'one' }, branch)
      .catch(() => ({ searchEntries: [] }))) as SearchResult;
    for (const e of res.searchEntries || [])
      await server.ldap.delete(String(e.dn)).catch(() => undefined);
    await server.ldap.delete(branch).catch(() => undefined);
    if (previousBase === undefined) delete process.env.DM_BCL_LDAP_BASE;
    else process.env.DM_BCL_LDAP_BASE = previousBase;
    if (previousRetention === undefined) delete process.env.DM_BCL_RETENTION;
    else process.env.DM_BCL_RETENTION = previousRetention;
  });

  it('should find a session again by its sid', async () => {
    await plugin.store.record({ iss: ISS, sid: 'sid-one' });
    expect(await plugin.store.isRevoked({ iss: ISS, sid: 'sid-one' })).to.equal(
      true
    );
  });

  it('should leave another session alone', async () => {
    expect(await plugin.store.isRevoked({ iss: ISS, sid: 'sid-two' })).to.equal(
      false
    );
  });

  it('should kill every session of a sub when the token names one', async () => {
    await plugin.store.record({ iss: ISS, sub: 'alice' });
    // A session of alice's, whose own sid was never named.
    expect(
      await plugin.store.isRevoked({ iss: ISS, sid: 'sid-three', sub: 'alice' })
    ).to.equal(true);
  });

  it('should not answer with a mark that has expired', async () => {
    process.env.DM_BCL_RETENTION = '3600';
    const stale = new BclLdap(server);
    stale.store.stopSweeping();
    // Retention in the past: the mark is written already expired.
    (stale.store as unknown as { retention: number }).retention = -1000;
    await stale.store.record({ iss: ISS, sid: 'sid-stale' });
    expect(
      await stale.store.isRevoked({ iss: ISS, sid: 'sid-stale' }),
      'an expired mark must not keep anyone out'
    ).to.equal(false);
  });

  it('should reclaim what has expired', async () => {
    const stale = new BclLdap(server);
    stale.store.stopSweeping();
    (stale.store as unknown as { retention: number }).retention = -1000;
    await stale.store.record({ iss: ISS, sid: 'sid-swept' });
    const gone = await stale.store.sweep();
    expect(gone).to.be.greaterThan(0);
    // The stale one is gone …
    expect(
      await stale.store.isRevoked({ iss: ISS, sid: 'sid-swept' })
    ).to.equal(false);
    // … and the live ones were not taken with it.
    expect(await plugin.store.isRevoked({ iss: ISS, sid: 'sid-one' })).to.equal(
      true
    );
  });

  it('should forget what would kill a session just established', async () => {
    // A logout token names a `sid` and a `sub`. The mark on the `sub` kills
    // every session of that person, so left in place it kills the ones
    // created afterwards — for the whole retention, which is a week.
    await plugin.store.record({ iss: ISS, sid: 'S1', sub: 'bob' });
    expect(
      await plugin.store.isRevoked({ iss: ISS, sid: 'S2', sub: 'bob' }),
      'a new session must be dead before login clears the mark'
    ).to.equal(true);

    await plugin.store.forget({ iss: ISS, sid: 'S2', sub: 'bob' });
    expect(
      await plugin.store.isRevoked({ iss: ISS, sid: 'S2', sub: 'bob' }),
      'and alive after it'
    ).to.equal(false);
  });
});
