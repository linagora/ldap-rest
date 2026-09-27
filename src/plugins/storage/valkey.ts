/**
 * @module plugins/storage/valkey
 *
 * A keyed store kept in Valkey, or Redis.
 *
 * `iovalkey` is an optional dependency, loaded when this backend is chosen: a
 * deployment that keeps its records elsewhere never needs it installed.
 *
 * The only backend that expires its own records, so it has nothing to sweep.
 * The value still carries its deadline, in the shape the LDAP store uses:
 * reads judge expiry by it, as with every other backend, and the TTL only
 * reclaims the memory.
 *
 * @group Plugins
 */
import type winston from 'winston';

import Store, { type StoredRecord } from '../../lib/storage/store';

type IoValkey = typeof import('iovalkey');
type Client = InstanceType<IoValkey['Valkey']>;

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : JSON.stringify(err);

export default class ValkeyStore extends Store {
  name = 'storage/valkey';
  private url: string;
  private prefix: string;
  private connection?: Promise<Client>;
  /** Set once a lost connection is reported, so a reconnect loop says it once. */
  private down = false;

  constructor(logger: winston.Logger, url: string, prefix: string) {
    super(logger);
    this.url = url;
    this.prefix = prefix;
  }

  /** Split out so a test can stand in for a missing package. */
  protected async driver(): Promise<IoValkey> {
    return import('iovalkey');
  }

  async open(): Promise<void> {
    await this.client();
  }

  async close(): Promise<void> {
    await super.close();
    const pending = this.connection;
    this.connection = undefined;
    const client = await pending?.catch(() => undefined);
    if (client) await client.quit().catch(() => client.disconnect());
  }

  /**
   * The client, once connected. A failed first connection is not kept: the
   * next operation tries again. Past that one, the client reconnects on its
   * own.
   */
  private client(): Promise<Client> {
    this.connection ??= this.connect().catch(err => {
      this.connection = undefined;
      throw err;
    });
    return this.connection;
  }

  private async connect(): Promise<Client> {
    let driver: IoValkey;
    try {
      driver = await this.driver();
    } catch (err) {
      throw new Error(
        `${this.name}: requires the optional dependency "iovalkey", which ` +
          'is not installed. Install it to keep the records in Valkey, or ' +
          `choose another --storage-backend. (${errorText(err)})`
      );
    }
    const client = new driver.Valkey(this.url, {
      lazyConnect: true,
      // Fail rather than wait: a command queued while the server is away
      // would hold the request that asked for it, a logout check included.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 5000,
    });
    // The client reports why a connection failed here, and rejects
    // `connect()` with a bare "Connection is closed".
    let cause: unknown;
    let connected = false;
    client.on('error', (err: unknown) => {
      cause = err;
      if (!connected || this.down) return;
      this.down = true;
      this.logger.warn(`${this.name}: connection lost: ${errorText(err)}`);
    });
    client.on('ready', () => {
      if (this.down) this.logger.info(`${this.name}: connection back`);
      this.down = false;
    });
    try {
      await client.connect();
      connected = true;
    } catch (err) {
      // Without this the client keeps reconnecting behind a connection
      // nobody holds any more.
      client.disconnect();
      throw new Error(
        `${this.name}: cannot connect: ${errorText(cause ?? err)}`
      );
    }
    return client;
  }

  private key(scoped: string): string {
    return `${this.prefix}${scoped}`;
  }

  protected async load(key: string): Promise<StoredRecord | null> {
    try {
      const value = await (await this.client()).get(this.key(key));
      return value === null ? null : ValkeyStore.decodeRecord(value);
    } catch (err) {
      this.logger.warn(
        `${this.name}: cannot read a record, the answer is a guess: ${errorText(err)}`
      );
      return null;
    }
  }

  protected async save(key: string, record: StoredRecord): Promise<void> {
    // Relative, not `PXAT`: an absolute instant is read by the server's
    // clock, and one running ahead of this server's would drop a record
    // reads still count as alive. What the relative form loses is the
    // latency, and it errs late.
    const ttl = Math.ceil(record.deadline - Date.now());
    try {
      const client = await this.client();
      if (ttl <= 0) {
        // Already dead: what it replaces goes, as it would with any other
        // backend on its next read.
        await client.del(this.key(key));
        return;
      }
      // One `SET` replaces the value and the TTL together, so a record
      // written twice takes the later deadline rather than keeping either.
      await client.set(
        this.key(key),
        ValkeyStore.encodeRecord(key, record),
        'PX',
        ttl
      );
    } catch (err) {
      this.logger.warn(
        `${this.name}: cannot write a record: ${errorText(err)}`
      );
      throw err;
    }
  }

  protected async drop(key: string): Promise<void> {
    try {
      await (await this.client()).del(this.key(key));
    } catch (err) {
      this.logger.warn(
        `${this.name}: cannot drop a record, it keeps counting: ${errorText(err)}`
      );
    }
  }

  /** The TTL has already reclaimed what expired. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async sweep(): Promise<number> {
    return 0;
  }
}
