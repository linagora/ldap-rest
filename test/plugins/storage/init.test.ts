/**
 * The store is opened before any consumer can write and the sweeper starts
 * after that attempt. A store that cannot open is logged and the server
 * starts, as the store tries again at each operation; only a backend no
 * retry can fix stops it, and lets go of the single instance.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expect } from 'chai';

import { DM } from '../../../src/bin';
import { UnusableBackend } from '../../../src/lib/storage/store';
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

  /** Lines `server.logger.error` writes from now on */
  const errorsOf = (server: DM): string[] => {
    const lines: string[] = [];
    const error = server.logger.error.bind(server.logger);
    server.logger.error = ((line: string, ...rest: unknown[]) => {
      lines.push(String(line));
      return error(line, ...rest);
    }) as typeof server.logger.error;
    return lines;
  };

  it('starts when the store cannot open, and says why', async () => {
    // A directory cannot be made under a file, whoever runs the test
    const file = join(dir, 'file');
    writeFileSync(file, '');
    process.env.DM_STORAGE_FILE_DIRECTORY = join(file, 'records');
    process.env.DM_PLUGINS = STORAGE;
    const server = new DM();
    // Loading starts with an import, so the spy is in place before it ends
    const errors = errorsOf(server);
    await server.ready;
    loaded = server.loadedPlugins.storage as Storage;
    expect(loaded, 'registered').to.not.equal(undefined);
    expect(errors.join('\n')).to.match(/ENOTDIR/);
  });

  it('sweeps after a failed open, as the sweep connects again', async () => {
    const server = new DM();
    await server.ready;
    const storage = new Storage(server);
    loaded = storage;
    const errors = errorsOf(server);
    const events: string[] = [];
    storage.store.open = (): Promise<void> => {
      events.push('open');
      return Promise.reject(new Error('no answer'));
    };
    storage.store.startSweeping = (): void => {
      events.push('sweep');
    };
    expect(await server.registerPlugin('storage', storage)).to.equal(true);
    expect(events).to.deep.equal(['open', 'sweep']);
    expect(errors).to.include('no answer');
    expect(server.loadedPlugins.storage).to.equal(storage);
  });

  it('does not start, nor hold the single instance, on an unusable backend', async () => {
    const server = new DM();
    await server.ready;
    const storage = new Storage(server);
    let swept = false;
    let closed = 0;
    storage.store.open = (): Promise<void> =>
      Promise.reject(new UnusableBackend('no driver'));
    storage.store.startSweeping = (): void => {
      swept = true;
    };
    const close = storage.close.bind(storage);
    storage.close = (): Promise<void> => {
      closed++;
      return close();
    };
    let refused: Error | undefined;
    await server
      .registerPlugin('storage', storage)
      .catch((err: Error) => (refused = err));
    expect(refused?.message).to.equal('no driver');
    expect(swept, 'swept').to.equal(false);
    expect(closed, 'closed').to.equal(1);
    expect(server.loadedPlugins).to.not.have.property('storage');
    // The constructor refuses a second instance while one holds the place:
    // building one is what shows close() let go of it
    expect(() => {
      loaded = new Storage(server);
    }).to.not.throw();
  });
});
