import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';
import type winston from 'winston';

import Storage from '../../../src/plugins/storage';
import FileStore from '../../../src/plugins/storage/file';
import PostgresStore from '../../../src/plugins/storage/postgres';
import ValkeyStore from '../../../src/plugins/storage/valkey';
import type Store from '../../../src/lib/storage/store';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

/** A PostgreSQL driver whose pool answers every query as `answer` says */
const fakePg = (answer: () => Promise<unknown>) => ({
  Pool: class {
    on(): void {}
    query = answer;
    async end(): Promise<void> {}
  },
});

/** A Valkey driver whose client answers PING as `answer` says */
const fakeValkey = (answer: () => Promise<string>) => ({
  Valkey: class {
    on(): this {
      return this;
    }
    async connect(): Promise<void> {}
    ping = answer;
    async quit(): Promise<void> {}
    disconnect(): void {}
  },
});

describe('Storage health', () => {
  it('is ok for a file store on a writable directory, not on a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'health-'));
    try {
      const store = new FileStore(logger, dir, 600);
      expect(await store.health()).to.equal('ok');
      const gone = new FileStore(logger, join(dir, 'missing'), 600);
      await gone.health().then(
        () => expect.fail('a missing directory answered'),
        () => undefined
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('asks PostgreSQL for a row', async () => {
    class Stubbed extends PostgresStore {
      constructor(public answer: () => Promise<unknown>) {
        super(logger, 'postgres://health', 'records');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protected async driver(): Promise<any> {
        return fakePg(this.answer);
      }
    }
    const fine = new Stubbed(async () => ({ rows: [{ t: 'records' }] }));
    expect(await fine.health()).to.equal('ok');
    const down = new Stubbed(async () => {
      throw new Error('connection refused');
    });
    await down.health().then(
      () => expect.fail('a database down answered'),
      () => undefined
    );
  });

  it('pings Valkey', async () => {
    class Stubbed extends ValkeyStore {
      constructor(public answer: () => Promise<string>) {
        super(logger, 'valkey://health', '');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protected async driver(): Promise<any> {
        return fakeValkey(this.answer);
      }
    }
    expect(await new Stubbed(async () => 'PONG').health()).to.equal('ok');
    await new Stubbed(async () => {
      throw new Error('connection lost');
    })
      .health()
      .then(
        () => expect.fail('a server away answered'),
        () => undefined
      );
  });

  it('is degraded, not failed, when the backend cannot answer', async () => {
    const plugin = Object.create(Storage.prototype) as Storage;
    plugin.store = {
      health: async (): Promise<'ok'> => 'ok',
    } as unknown as Store;
    expect(await plugin.health()).to.equal('ok');
    plugin.store = {
      health: async (): Promise<never> => {
        throw new Error('connection refused');
      },
    } as unknown as Store;
    expect(await plugin.health()).to.equal('degraded');
  });
});
