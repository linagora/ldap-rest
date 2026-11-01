import { expect } from 'chai';
import type { Client } from 'ldapts';

import LdapPool, { type PoolLogger } from '../../../src/lib/ldap/pool';

/** A client the pool drives without a directory behind it. */
class FakeClient {
  bound = false;
  unbound = false;
  searches = 0;
  readonly url: string;
  private readonly refuseBind: boolean;
  private readonly refuseSearch: boolean;

  constructor(
    url: string,
    behaviour: { bind?: boolean; search?: boolean } = {}
  ) {
    this.url = url;
    this.refuseBind = behaviour.bind ?? false;
    this.refuseSearch = behaviour.search ?? false;
  }

  async bind(): Promise<void> {
    if (this.refuseBind) throw new Error(`bind refused by ${this.url}`);
    this.bound = true;
  }

  async search(): Promise<unknown> {
    this.searches++;
    if (this.refuseSearch) throw new Error(`search refused by ${this.url}`);
    // The pool only waits for the answer, its shape is the driver's
    return {};
  }

  async unbind(): Promise<void> {
    this.unbound = true;
  }
}

const silentLogger: PoolLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const poolFor = (
  urls: string[],
  behaviour: Record<string, { bind?: boolean; search?: boolean }> = {},
  settings: { poolSize?: number; connectionTtl?: number } = {}
): { pool: LdapPool; clients: FakeClient[] } => {
  const clients: FakeClient[] = [];
  const pool = new LdapPool({
    urls,
    dn: 'cn=admin,dc=example,dc=com',
    pwd: 'secret',
    options: { url: urls[0], timeout: 0, connectTimeout: 0, strictDN: false },
    poolSize: settings.poolSize ?? 1,
    connectionTtl: settings.connectionTtl ?? 60_000,
    logger: silentLogger,
    clientFactory: options => {
      const client = new FakeClient(
        options.url as string,
        behaviour[options.url as string]
      );
      clients.push(client);
      return client as unknown as Client;
    },
  });
  return { pool, clients };
};

describe('LdapPool', () => {
  it('fails over to the next URL when the first refuses the bind', async () => {
    const { pool, clients } = poolFor(['ldap://first', 'ldap://second'], {
      'ldap://first': { bind: true },
    });
    const pooled = await pool.acquire();
    expect(pooled.client).to.equal(clients[1] as unknown as Client);
    expect(clients[0].bound).to.equal(false);
    expect(clients[1].bound).to.equal(true);
    pool.release(pooled);
    await pool.close();
  });

  it('reports the pool as busy, idle and within its size', async () => {
    const { pool } = poolFor(['ldap://one'], {}, { poolSize: 2 });
    expect(pool.stats()).to.deep.include({
      busy: 0,
      idle: 0,
      waiting: 0,
      opening: 0,
      max: 2,
    });
    const pooled = await pool.acquire();
    expect(pool.stats()).to.deep.include({
      busy: 1,
      idle: 0,
      waiting: 0,
      opening: 0,
      max: 2,
    });
    pool.release(pooled);
    expect(pool.stats()).to.deep.include({
      busy: 0,
      idle: 1,
      waiting: 0,
      opening: 0,
      max: 2,
    });
    await pool.close();
  });

  it('discards a connection past its TTL instead of reusing it', async () => {
    const { pool, clients } = poolFor(
      ['ldap://one'],
      {},
      { connectionTtl: -1 }
    );
    const first = await pool.acquire();
    pool.release(first);
    expect(clients[0].unbound, 'the expired connection is closed').to.equal(
      true
    );
    const second = await pool.acquire();
    expect(second, 'a new connection took its place').to.not.equal(first);
    expect(clients).to.have.length(2);
    pool.release(second);
    await pool.close();
  });

  it('releases the connection after the operation, failed or not', async () => {
    const { pool } = poolFor(['ldap://one']);
    const answer = await pool.withConnection(async () => 42);
    expect(answer).to.equal(42);
    expect(pool.stats()).to.deep.include({ busy: 0, idle: 1 });

    let refused: Error | undefined;
    try {
      await pool.withConnection(async () => {
        throw new Error('the operation failed');
      });
    } catch (error) {
      refused = error as Error;
    }
    expect(refused?.message).to.equal('the operation failed');
    expect(pool.stats()).to.deep.include({ busy: 0, idle: 1 });
    await pool.close();
  });

  it('probes each URL in turn, closing the connection it used', async () => {
    const { pool, clients } = poolFor(['ldap://first', 'ldap://second'], {
      'ldap://first': { search: true },
    });
    await pool.ping(1000);
    expect(clients).to.have.length(2);
    expect(
      clients[0].unbound,
      'the refused probe closed its connection'
    ).to.equal(true);
    expect(
      clients[1].unbound,
      'the answered probe closed its connection'
    ).to.equal(true);
    await pool.close();
  });

  it('refuses to acquire after close', async () => {
    const { pool, clients } = poolFor(['ldap://one']);
    const pooled = await pool.acquire();
    pool.release(pooled);
    await pool.close();
    expect(clients[0].unbound).to.equal(true);
    let refused: Error | undefined;
    try {
      await pool.acquire();
    } catch (error) {
      refused = error as Error;
    }
    expect(refused?.message).to.equal('LDAP connections closed');
  });
});
