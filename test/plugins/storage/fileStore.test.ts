/**
 * Keyed storage kept as files.
 *
 * The contract is thin on purpose — a key, a value, a deadline — so what is
 * worth testing is the handful of promises a consumer is allowed to lean on:
 *
 *  - a value comes back, and only until its deadline;
 *  - expiry is answered **on read**, whatever the sweeper has done, because a
 *    consumer must never be told a record is alive when it is not;
 *  - two consumers cannot collide, which is what the namespace is for;
 *  - the storage is reclaimed, and a temporary a write is still holding is
 *    not taken with it.
 */
import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import FileStore from '../../../src/plugins/storage/file';

const quiet = {
  warn: (): void => undefined,
  debug: (): void => undefined,
} as unknown as ConstructorParameters<typeof FileStore>[0];

describe('Keyed storage, in files', function () {
  let dir: string;
  let store: FileStore;
  const inAnHour = (): number => Date.now() + 3600_000;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-file-'));
    store = new FileStore(quiet, dir, 600);
    await store.ready();
  });

  after(() => {
    store?.stopSweeping();
    rmSync(dir, { recursive: true, force: true });
  });

  it('should give back what was kept', async () => {
    await store.set('bcl', 'k1', 'hello', inAnHour());
    expect(await store.get('bcl', 'k1')).to.equal('hello');
  });

  it('should know nothing of a key never written', async () => {
    expect(await store.get('bcl', 'never')).to.equal(null);
  });

  it('should keep two consumers apart', async () => {
    await store.set('bcl', 'shared', 'from bcl', inAnHour());
    await store.set('locks', 'shared', 'from locks', inAnHour());
    expect(await store.get('bcl', 'shared')).to.equal('from bcl');
    expect(await store.get('locks', 'shared')).to.equal('from locks');
  });

  it('should answer expiry on read, before any sweep', async () => {
    await store.set('bcl', 'stale', 'gone', Date.now() - 1000);
    expect(
      await store.get('bcl', 'stale'),
      'a consumer must never be told an expired record is alive'
    ).to.equal(null);
  });

  it('should forget a key on demand', async () => {
    await store.set('bcl', 'k2', 'here', inAnHour());
    await store.delete('bcl', 'k2');
    expect(await store.get('bcl', 'k2')).to.equal(null);
  });

  it('should keep the records unreadable by anyone else', async () => {
    const names = (await fs.readdir(dir)).filter(n => !n.endsWith('.tmp'));
    expect(names.length).to.be.greaterThan(0);
    expect((await fs.stat(join(dir, names[0]))).mode & 0o777).to.equal(0o600);
  });

  it('should leave a temporary a write may still be holding', async () => {
    const inflight = join(dir, 'inflight.tmp');
    await fs.writeFile(inflight, 'busy');
    await store.sweep();
    expect(await fs.readdir(dir)).to.include('inflight.tmp');
    await fs.unlink(inflight);
  });

  it('should reclaim what expired, and what an interrupted write left', async () => {
    await store.set('bcl', 'swept', 'gone', Date.now() - 1000);
    const abandoned = join(dir, 'abandoned.tmp');
    await fs.writeFile(abandoned, 'nobody');
    const past = new Date(Date.now() - 3600_000);
    await fs.utimes(abandoned, past, past);

    expect(await store.sweep()).to.be.greaterThan(0);
    expect(await fs.readdir(dir)).to.not.include('abandoned.tmp');
    // The live ones stayed.
    expect(await store.get('bcl', 'k1')).to.equal('hello');
  });

  it('should keep a value that has a newline in it', async () => {
    // The record's own format puts the deadline on the first line and the
    // value after it, so a value with newlines is where a naive split breaks.
    await store.set('bcl', 'multi', 'one\ntwo\nthree', inAnHour());
    expect(await store.get('bcl', 'multi')).to.equal('one\ntwo\nthree');
  });
});
