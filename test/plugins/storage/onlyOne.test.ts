/**
 * One storage plugin, held by the code rather than by a comment.
 *
 * Two of them put the same record in two places, and leave registration
 * order — invisible in a configuration — to decide which one answers when the
 * other is unwell. `--storage-backend` is a single value, but nothing stops a
 * second instance arriving under another name, so the guarantee is refused
 * rather than assumed. `core/auth/llng` makes the same call for the same
 * reason.
 */
import { expect } from 'chai';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DM } from '../../../src/bin';
import Storage from '../../../src/plugins/storage';

describe('Keyed storage, one instance', function () {
  let server: DM;
  let dir: string;
  let first: Storage;
  const previous: Record<string, string | undefined> = {};

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'storage-one-'));
    for (const k of [
      'DM_STORAGE_BACKEND',
      'DM_STORAGE_FILE_DIRECTORY',
      'DM_STORAGE_SWEEP_INTERVAL',
    ])
      previous[k] = process.env[k];
    process.env.DM_STORAGE_BACKEND = 'file';
    process.env.DM_STORAGE_FILE_DIRECTORY = dir;
    // No sweeper: this suite is about loading, not about reclaiming.
    process.env.DM_STORAGE_SWEEP_INTERVAL = '0';
    server = new DM();
    await server.ready;
  });

  after(() => {
    if (first) {
      first.store.stopSweeping();
      Storage.release(first);
    }
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('should load one', () => {
    first = new Storage(server);
    expect(first.store.name).to.equal('storage/file');
  });

  it('should refuse a second, naming what already holds the records', () => {
    expect(() => new Storage(server)).to.throw(
      /already loaded.*storage\/file/s
    );
  });

  it('should refuse a backend it does not know', () => {
    Storage.release(first);
    process.env.DM_STORAGE_BACKEND = 'carrier-pigeon';
    const other = new DM();
    expect(() => new Storage(other)).to.throw(/unknown backend/);
    process.env.DM_STORAGE_BACKEND = 'file';
    first = new Storage(server);
  });
});
