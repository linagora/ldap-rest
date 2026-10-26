import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';

import { DM } from '../../../src/bin';
import type winston from 'winston';

import Storage from '../../../src/plugins/storage';
import FileStore from '../../../src/plugins/storage/file';
import PostgresStore from '../../../src/plugins/storage/postgres';
import ValkeyStore from '../../../src/plugins/storage/valkey';
import LdapStore from '../../../src/plugins/storage/ldap';
import type Store from '../../../src/lib/storage/store';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

/** A PostgreSQL driver whose clients answer every query as `answer` says */
const fakePg = (answer: (text: string) => Promise<unknown>) => ({
  Pool: class {
    on(): void {}
    query = answer;
    async end(): Promise<void> {}
  },
  Client: class {
    async connect(): Promise<void> {}
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
      const fresh = new FileStore(logger, join(dir, 'fresh'), 600);
      await fresh.open();
      expect(await fresh.health(), 'made at open').to.equal('ok');
      const refused = async (store: FileStore, what: string): Promise<void> =>
        store.health().then(
          () => expect.fail(`${what} answered`),
          () => undefined
        );
      await refused(
        new FileStore(logger, join(dir, 'missing'), 600),
        'a missing directory'
      );
      await writeFile(join(dir, 'file'), '');
      await refused(new FileStore(logger, join(dir, 'file'), 600), 'a file');
      if (process.getuid?.() !== 0) {
        await mkdir(join(dir, 'sealed'), { mode: 0o500 });
        await chmod(join(dir, 'sealed'), 0o500);
        await refused(
          new FileStore(logger, join(dir, 'sealed'), 600),
          'a read-only directory'
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('asks PostgreSQL for a row on a client of its own', async () => {
    class Stubbed extends PostgresStore {
      constructor(public answer: (text: string) => Promise<unknown>) {
        super(logger, 'postgres://health', 'records');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protected async driver(): Promise<any> {
        return fakePg(this.answer);
      }
    }
    const asked: string[] = [];
    const fine = new Stubbed(async text => {
      asked.push(text);
      return { rows: [{ t: 'records' }] };
    });
    expect(await fine.health()).to.equal('ok');
    expect(asked).to.deep.equal(['SELECT 1']);
    const gone = new Stubbed(async () => {
      throw new Error('connection terminated');
    });
    await gone.health().then(
      () => expect.fail('a database gone answered'),
      () => undefined
    );
  });

  it('has nothing of its own to ask with the ldap backend', async () => {
    const store = Object.create(LdapStore.prototype) as LdapStore;
    expect(await store.health()).to.equal('ok');
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

  it('is degraded, not failed, when the backend cannot answer, and says so once', async () => {
    const lines: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'health-'));
    const server = new DM();
    await server.ready;
    server.config.storage_backend = 'file';
    server.config.storage_file_directory = dir;
    const plugin = new Storage(server);
    Storage.release(plugin);
    plugin.logger = {
      ...logger,
      warn: (line: string) => lines.push(`warn ${line}`),
      info: (line: string) => lines.push(`info ${line}`),
    } as unknown as winston.Logger;
    const answering = { name: 'stub', health: async (): Promise<'ok'> => 'ok' };
    const refusing = {
      name: 'stub',
      health: async (): Promise<never> => {
        throw new Error('connection refused');
      },
    };
    plugin.store = answering as unknown as Store;
    expect(await plugin.health()).to.equal('ok');
    plugin.store = refusing as unknown as Store;
    expect(await plugin.health()).to.equal('degraded');
    expect(await plugin.health()).to.equal('degraded');
    plugin.store = answering as unknown as Store;
    expect(await plugin.health()).to.equal('ok');
    expect(lines).to.deep.equal([
      'warn stub: does not answer: connection refused',
      'info stub: answers again',
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});
