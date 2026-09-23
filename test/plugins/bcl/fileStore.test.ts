/**
 * Back-Channel Logout tombstones kept as files.
 *
 * The same contract as the LDAP store, and the same three obligations: a mark
 * is found again, it stops counting once expired, and the sweeper reclaims
 * it. Two things belong to this backend alone — the records are written
 * atomically, so a reader never meets a half-written one and takes a live
 * mark for an expired one; and a temporary file left by an interrupted write
 * is nobody's, so the sweeper takes it.
 *
 * It needs no LDAP, so it runs anywhere.
 */
import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import BclStore from '../../../src/lib/bcl/store';
import BclFile from '../../../src/plugins/bcl/file';

// The store is exercised directly: the plugin around it only reads the
// configuration and subscribes the two hooks.
type Store = BclStore & {
  ready(): Promise<void>;
  sweep(): Promise<number>;
};

describe('Back-Channel Logout, tombstones in files', function () {
  let dir: string;
  let store: Store;
  const ISS = 'https://sso.example.com';
  const logger = {
    warn: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as Parameters<typeof makeStore>[0];

  const makeStore = (log: unknown, retention: number): Store => {
    // The store is reached through the plugin, the way the server builds it,
    // with the configuration it reads and nothing else: this backend needs no
    // directory server.
    const plugin = new BclFile({
      logger: log,
      config: { bcl_file_directory: dir, bcl_retention: retention },
      hooks: {},
    } as never);
    plugin.store.stopSweeping();
    return plugin.store as unknown as Store;
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bcl-file-'));
    store = makeStore(logger, 3600);
    await store.ready();
  });

  after(() => {
    store?.stopSweeping();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should find a session again by its sid', async () => {
    await store.record({ iss: ISS, sid: 'sid-one' });
    expect(await store.isRevoked({ iss: ISS, sid: 'sid-one' })).to.equal(true);
  });

  it('should leave another session alone', async () => {
    expect(await store.isRevoked({ iss: ISS, sid: 'sid-two' })).to.equal(false);
  });

  it('should kill every session of a sub when the token names one', async () => {
    await store.record({ iss: ISS, sub: 'alice' });
    expect(
      await store.isRevoked({ iss: ISS, sid: 'never-named', sub: 'alice' })
    ).to.equal(true);
  });

  it('should keep the records unreadable by anyone else', async () => {
    const names = (await fs.readdir(dir)).filter(n => !n.endsWith('.tmp'));
    expect(names.length).to.be.greaterThan(0);
    const mode = (await fs.stat(join(dir, names[0]))).mode & 0o777;
    expect(mode).to.equal(0o600);
  });

  it('should not answer with a mark that has expired', async () => {
    const stale = makeStore(logger, -1);
    await stale.record({ iss: ISS, sid: 'sid-stale' });
    expect(
      await stale.isRevoked({ iss: ISS, sid: 'sid-stale' }),
      'an expired mark must not keep anyone out'
    ).to.equal(false);
  });

  it('should leave a temporary file a write may still be holding', async () => {
    const inflight = join(dir, 'inflight.tmp');
    await fs.writeFile(inflight, '0 busy\n');
    await store.sweep();
    expect(await fs.readdir(dir)).to.include('inflight.tmp');
    await fs.unlink(inflight);
  });

  it('should forget what would kill a session just established', async () => {
    await store.record({ iss: ISS, sid: 'S1', sub: 'bob' });
    expect(
      await store.isRevoked({ iss: ISS, sid: 'S2', sub: 'bob' }),
      'a new session must be dead before login clears the mark'
    ).to.equal(true);
    await store.forget({ iss: ISS, sid: 'S2', sub: 'bob' });
    expect(
      await store.isRevoked({ iss: ISS, sid: 'S2', sub: 'bob' }),
      'and alive after it'
    ).to.equal(false);
  });

  it('should reclaim what has expired, and what an interrupted write left', async () => {
    const stale = makeStore(logger, -1);
    await stale.record({ iss: ISS, sid: 'sid-swept' });
    // Old enough to be nobody's: a fresh one may be a write in flight, and
    // taking it would make its rename fail and lose the tombstone.
    const abandoned = join(dir, 'abandoned.tmp');
    await fs.writeFile(abandoned, '0 nobody\n');
    const past = new Date(Date.now() - 3600_000);
    await fs.utimes(abandoned, past, past);
    const gone = await stale.sweep();
    expect(gone).to.be.greaterThan(0);
    const left = await fs.readdir(dir);
    expect(left).to.not.include('abandoned.tmp');
    // The live ones stay.
    expect(await store.isRevoked({ iss: ISS, sid: 'sid-one' })).to.equal(true);
  });
});
