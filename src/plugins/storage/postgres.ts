/**
 * @module plugins/storage/postgres
 *
 * A keyed store kept in one PostgreSQL table.
 *
 * `pg` is an optional dependency, loaded when this backend is chosen: a
 * deployment that keeps its records elsewhere never needs it installed.
 *
 * The key is kept verbatim, split into the consumer's namespace and its own
 * key: a `text` column has no reason to hash it the way a DN or a file name
 * must, so a `SELECT` says what a record is about.
 *
 * @group Plugins
 */
import type winston from 'winston';

import Store, { type StoredRecord } from '../../lib/storage/store';

type Pg = typeof import('pg');
type Pool = InstanceType<Pg['Pool']>;

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : JSON.stringify(err);

const quote = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;

export default class PostgresStore extends Store {
  name = 'storage/postgres';
  private url: string;
  private table: string;
  /** `schema.table` or `table`, each part quoted. */
  private quoted: string;
  private connection?: Promise<Pool>;

  constructor(logger: winston.Logger, url: string, table: string) {
    super(logger);
    this.url = url;
    this.table = table;
    this.quoted = table.split('.').map(quote).join('.');
  }

  /** Split out so a test can stand in for a missing package. */
  protected async driver(): Promise<Pg> {
    return import('pg');
  }

  async open(): Promise<void> {
    await this.pool();
  }

  async close(): Promise<void> {
    await super.close();
    const pending = this.connection;
    this.connection = undefined;
    if (pending) await (await pending.catch(() => undefined))?.end();
  }

  /**
   * The pool, once the table is known to be there. A failure is not kept:
   * the next operation tries again, so a database down at startup does not
   * leave the store unusable once it is back.
   */
  private pool(): Promise<Pool> {
    this.connection ??= this.connect().catch(err => {
      this.connection = undefined;
      throw err;
    });
    return this.connection;
  }

  private async connect(): Promise<Pool> {
    let pg: Pg;
    try {
      pg = await this.driver();
    } catch (err) {
      throw new Error(
        `${this.name}: requires the optional dependency "pg", which is not ` +
          'installed. Install it to keep the records in PostgreSQL, or ' +
          `choose another --storage-backend. (${errorText(err)})`
      );
    }
    const pool = new pg.Pool({
      connectionString: this.url,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
    // An idle connection the server drops is reported here; without a
    // listener, that event takes the whole process down.
    pool.on('error', err =>
      this.logger.warn(`${this.name}: connection lost: ${errorText(err)}`)
    );
    try {
      await this.ensureTable(pool);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw new Error(
        `${this.name}: cannot use table ${this.table}: ${errorText(err)}`
      );
    }
    return pool;
  }

  /**
   * Create the table when it is not there.
   *
   * Looked up first: `CREATE … IF NOT EXISTS` still needs the right to create
   * in the schema, which a role granted only this table's rows does not have.
   */
  private async ensureTable(pool: Pool): Promise<void> {
    const found = await pool.query<{ t: string | null }>(
      'SELECT to_regclass($1) AS t',
      [this.quoted]
    );
    if (found.rows[0]?.t) return;
    const table = this.quoted;
    const index = quote(`${this.table.split('.').pop() as string}_expires_at`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        namespace text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (namespace, key)
      )`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${index} ON ${table} (expires_at)`
    );
    this.logger.info(`${this.name}: created table ${this.table}`);
  }

  /**
   * The namespace and the consumer's own key. PostgreSQL refuses NUL in
   * `text`, so a key holding one cannot be kept: `null` says so.
   */
  private static parts(scoped: string): [string, string] | null {
    const cut = scoped.indexOf('\u0000');
    const key = scoped.slice(cut + 1);
    if (key.includes('\u0000')) return null;
    return [scoped.slice(0, cut), key];
  }

  protected async load(key: string): Promise<StoredRecord | null> {
    const parts = PostgresStore.parts(key);
    // Nothing can have been written under it.
    if (!parts) return null;
    try {
      const pool = await this.pool();
      const res = await pool.query<{ value: string; expires_at: Date }>(
        `SELECT value, expires_at FROM ${this.quoted}
          WHERE namespace = $1 AND key = $2`,
        parts
      );
      const row = res.rows[0];
      return row
        ? { value: row.value, deadline: row.expires_at.getTime() }
        : null;
    } catch (err) {
      this.logger.warn(
        `${this.name}: cannot read a record, the answer is a guess: ${errorText(err)}`
      );
      return null;
    }
  }

  protected async save(key: string, record: StoredRecord): Promise<void> {
    const parts = PostgresStore.parts(key);
    if (!parts)
      throw new Error(`${this.name}: cannot keep a key holding a NUL`);
    try {
      const pool = await this.pool();
      // A record written twice is the ordinary case — a redelivered logout
      // token — and the later one wins, deadline included.
      await pool.query(
        `INSERT INTO ${this.quoted}
          (namespace, key, value, expires_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (namespace, key) DO UPDATE
          SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [...parts, record.value, new Date(record.deadline)]
      );
    } catch (err) {
      this.logger.warn(
        `${this.name}: cannot write a record: ${errorText(err)}`
      );
      throw err;
    }
  }

  protected async drop(key: string): Promise<void> {
    const parts = PostgresStore.parts(key);
    if (!parts) return;
    try {
      const pool = await this.pool();
      await pool.query(
        `DELETE FROM ${this.quoted}
          WHERE namespace = $1 AND key = $2`,
        parts
      );
    } catch (err) {
      this.logger.warn(
        `${this.name}: cannot drop a record, it keeps counting: ${errorText(err)}`
      );
    }
  }

  async sweep(): Promise<number> {
    const pool = await this.pool();
    // This server's clock, not the database's `now()`: reads judge expiry by
    // this clock, and a database running ahead would otherwise sweep a record
    // a read still counts as alive.
    const res = await pool.query(
      `DELETE FROM ${this.quoted} WHERE expires_at <= $1`,
      [new Date()]
    );
    return res.rowCount ?? 0;
  }
}
