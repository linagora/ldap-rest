/**
 * Keyed storage kept in Valkey.
 *
 * The same contract as the other stores, against a real server named by
 * `DM_TEST_VALKEY_URL`, plus what belongs to this backend: the TTL follows
 * the deadline — replaced, not extended, when a record is written twice — and
 * the value still carries that deadline for reads to judge by.
 */
import { expect } from 'chai';
import { Valkey } from 'iovalkey';

import ValkeyStore from '../../../src/plugins/storage/valkey';
import { skipIfMissingEnvVars } from '../../helpers/env';

const warnings: string[] = [];
const logger = {
  warn: (m: string): void => void warnings.push(m),
  info: (): void => undefined,
  debug: (): void => undefined,
  error: (): void => undefined,
} as unknown as ConstructorParameters<typeof ValkeyStore>[0];

describe('Keyed storage, in Valkey', function () {
  const prefix = 'ldap-rest-test:';
  let admin: Valkey;
  let store: ValkeyStore;
  const inAnHour = (): number => Date.now() + 3600_000;

  const clean = async (): Promise<void> => {
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length) await admin.del(...keys);
  };

  before(async function () {
    skipIfMissingEnvVars(this, ['DM_TEST_VALKEY_URL']);
    const url = process.env.DM_TEST_VALKEY_URL as string;
    admin = new Valkey(url);
    await clean();
    store = new ValkeyStore(logger, url, prefix);
    await store.open();
  });

  after(async () => {
    await store?.close();
    if (admin) {
      await clean();
      await admin.quit();
    }
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

  it('should keep a value that has a newline in it', async () => {
    await store.set('bcl', 'multi', 'one\ntwo\nthree', inAnHour());
    expect(await store.get('bcl', 'multi')).to.equal('one\ntwo\nthree');
  });

  it('should expire the key with the record', async () => {
    await store.set('bcl', 'ttl', 'v', Date.now() + 60_000);
    const ttl = await admin.pttl(`${prefix}bcl\u0000ttl`);
    expect(ttl).to.be.within(55_000, 60_000);
    expect(await admin.get(`${prefix}bcl\u0000ttl`)).to.match(/^\d+ bcl:ttl\n/);
  });

  it('should take the later deadline when a key is written twice', async () => {
    // A redelivery near the end of the first record's life must not keep the
    // shorter one: `SET … PX` replaces the TTL, `SETNX` + `EXPIRE` would not.
    await store.set('bcl', 'twice', 'first', Date.now() + 60_000);
    await store.set('bcl', 'twice', 'second', Date.now() + 3600_000);
    expect(await store.get('bcl', 'twice')).to.equal('second');
    expect(await admin.pttl(`${prefix}bcl\u0000twice`)).to.be.greaterThan(
      3500_000
    );
    // And the other way: a shorter deadline shortens it.
    await store.set('bcl', 'twice', 'third', Date.now() + 60_000);
    expect(await admin.pttl(`${prefix}bcl\u0000twice`)).to.be.at.most(60_000);
  });

  it('should answer expiry on read, and drop what an expired write replaces', async () => {
    await store.set('bcl', 'stale', 'alive', inAnHour());
    await store.set('bcl', 'stale', 'gone', Date.now() - 1000);
    expect(await store.get('bcl', 'stale')).to.equal(null);
    expect(await admin.exists(`${prefix}bcl\u0000stale`)).to.equal(0);
  });

  it('should judge by the deadline it carries, whatever the TTL says', async () => {
    // A record whose TTL outlives its deadline — written by hand, or by a
    // server whose clock drifted — is still dead on read.
    await admin.set(
      `${prefix}bcl\u0000drift`,
      `${Date.now() - 1000} bcl:drift\nold`,
      'PX',
      60_000
    );
    expect(await store.get('bcl', 'drift')).to.equal(null);
  });

  it('should forget a key on demand', async () => {
    await store.set('bcl', 'k2', 'here', inAnHour());
    await store.delete('bcl', 'k2');
    expect(await store.get('bcl', 'k2')).to.equal(null);
  });
});

describe('Keyed storage, in Valkey, when it cannot be reached', function () {
  it('should name the missing package', async () => {
    class Missing extends ValkeyStore {
      protected driver(): Promise<typeof import('iovalkey')> {
        return Promise.reject(new Error("Cannot find package 'iovalkey'"));
      }
    }
    const store = new Missing(logger, 'redis://nowhere', 'p:');
    let raised: unknown;
    try {
      await store.open();
    } catch (err) {
      raised = err;
    }
    expect(String(raised)).to.match(/optional dependency "iovalkey"/);
  });

  it('should answer a read with a warning and raise a write', async function () {
    this.timeout(20000);
    const store = new ValkeyStore(logger, 'redis://127.0.0.1:1', 'p:');
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
