/**
 * Keyed storage kept in PostgreSQL.
 *
 * The same contract as the other stores, against a real database named by
 * `DM_TEST_POSTGRES_URL`, plus what belongs to this backend: a record written
 * twice takes the update path, the key is readable in the table, a role that
 * may not create tables still works once the table is there, and the sweep
 * judges expiry by this server's clock.
 */
import { expect } from 'chai';
import { Pool } from 'pg';

import PostgresStore from '../../../src/plugins/storage/postgres';
import { skipIfMissingEnvVars } from '../../helpers/env';

const warnings: string[] = [];
const logger = {
  warn: (m: string): void => void warnings.push(m),
  info: (): void => undefined,
  debug: (): void => undefined,
  error: (): void => undefined,
} as unknown as ConstructorParameters<typeof PostgresStore>[0];

describe('Keyed storage, in PostgreSQL', function () {
  const table = 'ldap_rest_storage_test';
  let url: string;
  let admin: Pool;
  let store: PostgresStore;
  const inAnHour = (): number => Date.now() + 3600_000;

  before(async function () {
    skipIfMissingEnvVars(this, ['DM_TEST_POSTGRES_URL']);
    url = process.env.DM_TEST_POSTGRES_URL as string;
    admin = new Pool({ connectionString: url });
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    store = new PostgresStore(logger, url, table);
    await store.open();
  });

  after(async () => {
    await store?.close();
    await admin?.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await admin?.end();
  });

  it('should create its table', async () => {
    const res = await admin.query('SELECT to_regclass($1) AS t', [table]);
    expect(res.rows[0].t).to.equal(table);
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

  it('should not let a colon in a namespace reach another consumer', async () => {
    await store.set('bcl', 'x:y', 'written by (bcl, x:y)', inAnHour());
    await store.set('bcl:x', 'y', 'written by (bcl:x, y)', inAnHour());
    expect(await store.get('bcl', 'x:y')).to.equal('written by (bcl, x:y)');
    expect(await store.get('bcl:x', 'y')).to.equal('written by (bcl:x, y)');
  });

  it('should take the same key twice without raising, the later deadline winning', async () => {
    const later = inAnHour() + 60_000;
    await store.set('bcl', 'twice', 'first', inAnHour());
    await store.set('bcl', 'twice', 'second', later);
    expect(await store.get('bcl', 'twice')).to.equal('second');
    const res = await admin.query(
      `SELECT expires_at FROM ${table} WHERE namespace = 'bcl' AND key = 'twice'`
    );
    expect((res.rows[0].expires_at as Date).getTime()).to.equal(later);
  });

  it('should keep the key readable in the table', async () => {
    await store.set('bcl', 'https://op.example.com sid-1', 'v', inAnHour());
    const res = await admin.query(
      `SELECT value FROM ${table} WHERE namespace = 'bcl' AND key = $1`,
      ['https://op.example.com sid-1']
    );
    expect(res.rows[0]?.value).to.equal('v');
  });

  it('should keep a value that has a newline in it', async () => {
    await store.set('bcl', 'multi', 'one\ntwo\nthree', inAnHour());
    expect(await store.get('bcl', 'multi')).to.equal('one\ntwo\nthree');
  });

  it('should answer expiry on read, before any sweep', async () => {
    await store.set('bcl', 'stale', 'gone', Date.now() - 1000);
    expect(await store.get('bcl', 'stale')).to.equal(null);
  });

  it('should forget a key on demand', async () => {
    await store.set('bcl', 'k2', 'here', inAnHour());
    await store.delete('bcl', 'k2');
    expect(await store.get('bcl', 'k2')).to.equal(null);
  });

  it('should refuse a key holding a NUL, and know nothing of it', async () => {
    let raised: unknown;
    try {
      await store.set('bcl', 'a\u0000b', 'v', inAnHour());
    } catch (err) {
      raised = err;
    }
    expect(raised, 'a write that did not happen is raised').to.be.an('error');
    expect(await store.get('bcl', 'a\u0000b')).to.equal(null);
  });

  it('should reclaim what expired and leave the rest', async () => {
    await store.set('bcl', 'swept', 'gone', Date.now() - 1000);
    expect(await store.sweep()).to.be.greaterThan(0);
    const res = await admin.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE expires_at <= now()`
    );
    expect(res.rows[0].n).to.equal(0);
    expect(await store.get('bcl', 'k1')).to.equal('hello');
  });

  it('should work for a role that may not create the table', async function () {
    const role = 'ldap_rest_storage_test_role';
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    try {
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${role}`
      );
      const limited = new URL(url);
      limited.username = role;
      limited.password = 'pw';
      const other = new PostgresStore(logger, limited.toString(), table);
      try {
        await other.open();
        await other.set('bcl', 'limited', 'yes', inAnHour());
        expect(await other.get('bcl', 'limited')).to.equal('yes');
      } finally {
        await other.close();
      }
    } finally {
      await admin
        .query(`REVOKE ALL ON ${table} FROM ${role}`)
        .catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
  });
});

describe('Keyed storage, in PostgreSQL, when it cannot be reached', function () {
  it('should name the missing package', async () => {
    class Missing extends PostgresStore {
      protected driver(): Promise<typeof import('pg')> {
        return Promise.reject(new Error("Cannot find package 'pg'"));
      }
    }
    const store = new Missing(logger, 'postgres://nowhere/db', 't');
    let raised: unknown;
    try {
      await store.open();
    } catch (err) {
      raised = err;
    }
    expect(String(raised)).to.match(/optional dependency "pg"/);
  });

  it('should answer a read with a warning and raise a write', async function () {
    this.timeout(20000);
    // Port 1 is refused at once, which keeps this test fast.
    const store = new PostgresStore(
      logger,
      'postgres://u:p@127.0.0.1:1/db',
      't'
    );
    warnings.length = 0;
    try {
      expect(await store.get('bcl', 'k')).to.equal(null);
      expect(warnings.join('\n')).to.match(/cannot read a record/);
      let raised: unknown;
      try {
        await store.set('bcl', 'k', 'v', Date.now() + 1000);
      } catch (err) {
        raised = err;
      }
      expect(raised).to.be.an('error');
    } finally {
      await store.close();
    }
  });
});
