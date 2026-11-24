/**
 * The store is open before any consumer can write, the sweeper starts on an
 * open store, and a store that cannot open stops the server.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expect } from 'chai';

import { DM } from '../../../src/bin';
import Storage from '../../../src/plugins/storage';

// Loaded as the CLI loads it, from the build: the loader imports a path
const STORAGE = '../../dist/plugins/storage.js';

const KEYS = [
  'DM_PLUGINS',
  'DM_STORAGE_BACKEND',
  'DM_STORAGE_FILE_DIRECTORY',
  'DM_STORAGE_SWEEP_INTERVAL',
  'NODE_ENV',
];

describe('Keyed storage, opened at startup', () => {
  const env: Record<string, string | undefined> = {};
  let dir: string;
  let loaded: Storage | undefined;

  beforeEach(() => {
    for (const k of KEYS) env[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'storage-init-'));
    process.env.NODE_ENV = 'test';
    process.env.DM_STORAGE_BACKEND = 'file';
    process.env.DM_STORAGE_FILE_DIRECTORY = join(dir, 'records');
    process.env.DM_STORAGE_SWEEP_INTERVAL = '600';
    delete process.env.DM_PLUGINS;
  });

  afterEach(async () => {
    if (loaded) {
      await loaded.close();
      // The class of the instance: the build's holds its own single instance
      (loaded.constructor as typeof Storage).release(loaded);
      loaded = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('starts sweeping once the store is open, before it registers', async () => {
    const server = new DM();
    await server.ready;
    const storage = new Storage(server);
    loaded = storage;
    const events: string[] = [];
    let opened!: () => void;
    storage.store.open = (): Promise<void> =>
      new Promise<void>(resolve => {
        events.push('open');
        opened = (): void => {
          events.push('opened');
          resolve();
        };
      });
    storage.store.startSweeping = (): void => {
      events.push('sweep');
    };
    const registered = server.registerPlugin('storage', storage);
    await new Promise(resolve => setImmediate(resolve));
    expect(events, 'before open settled').to.deep.equal(['open']);
    expect(server.loadedPlugins).to.not.have.property('storage');
    opened();
    expect(await registered).to.equal(true);
    expect(events).to.deep.equal(['open', 'opened', 'sweep']);
    expect(server.loadedPlugins.storage).to.equal(storage);
  });

  it('is ready with the store open', async () => {
    process.env.DM_PLUGINS = STORAGE;
    const server = new DM();
    await server.ready;
    loaded = server.loadedPlugins.storage as Storage;
    expect(await loaded.store.health()).to.equal('ok');
  });

  it('does not start when the store cannot open', async () => {
    // A directory cannot be made under a file, whoever runs the test
    const file = join(dir, 'file');
    writeFileSync(file, '');
    process.env.DM_STORAGE_FILE_DIRECTORY = join(file, 'records');
    process.env.DM_PLUGINS = STORAGE;
    const server = new DM();
    let refused: Error | undefined;
    await server.ready.catch((err: Error) => {
      refused = err;
    });
    expect(refused, 'ready rejected').to.be.instanceOf(Error);
    expect(refused!.message).to.match(/ENOTDIR/);
    expect(server.loadedPlugins).to.not.have.property('storage');
  });

  it('does not sweep nor hold the single instance after a failed open', async () => {
    const server = new DM();
    await server.ready;
    const storage = new Storage(server);
    let swept = false;
    storage.store.open = (): Promise<void> =>
      Promise.reject(new Error('no answer'));
    storage.store.startSweeping = (): void => {
      swept = true;
    };
    let refused: Error | undefined;
    await server
      .registerPlugin('storage', storage)
      .catch((err: Error) => (refused = err));
    expect(refused?.message).to.equal('no answer');
    expect(swept, 'swept').to.equal(false);
    expect(server.loadedPlugins).to.not.have.property('storage');
    loaded = new Storage(server);
  });
});
