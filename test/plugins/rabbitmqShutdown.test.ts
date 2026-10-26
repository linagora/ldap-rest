/**
 * A SIGTERM listener replaces Node's default action, which is to exit. The
 * listener `core/rabbitmq` installs closed the broker connection and
 * returned, so the process lived on until it was killed.
 */
import { expect } from 'chai';

import { registerProcessShutdown } from '../../src/plugins/rabbitmq';

type Kill = typeof process.kill;

describe('core/rabbitmq process shutdown', () => {
  let kill: Kill;
  let killed: Array<[number, string | number | undefined]>;

  beforeEach(() => {
    kill = process.kill;
    killed = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killed.push([pid, signal]);
      return true;
    }) as Kill;
  });

  afterEach(() => {
    process.kill = kill;
  });

  const settled = (): Promise<void> =>
    new Promise(resolve => setImmediate(resolve));

  it('raises the signal again once every callback has settled', async () => {
    const order: string[] = [];
    registerProcessShutdown(() => {
      order.push('sync');
    });
    registerProcessShutdown(async () => {
      await settled();
      order.push('async');
    });
    const before = process.listenerCount('SIGTERM');

    process.emit('SIGTERM', 'SIGTERM');
    expect(order).to.deep.equal(['sync']);
    expect(killed).to.deep.equal([]);

    await settled();
    await settled();
    expect(order).to.deep.equal(['sync', 'async']);
    expect(killed).to.deep.equal([[process.pid, 'SIGTERM']]);
    expect(process.listenerCount('SIGTERM')).to.equal(before - 1);
    expect(process.listenerCount('SIGINT')).to.equal(
      process.listenerCount('SIGTERM')
    );
  });

  it('raises the signal again when a callback throws', async () => {
    registerProcessShutdown(() => {
      throw new Error('broker already gone');
    });

    process.emit('SIGINT', 'SIGINT');
    await settled();
    await settled();
    expect(killed).to.deep.equal([[process.pid, 'SIGINT']]);
  });

  it('leaves the decision to another listener of the signal', async () => {
    const other = (): void => undefined;
    process.on('SIGTERM', other);
    try {
      registerProcessShutdown(() => undefined);
      process.emit('SIGTERM', 'SIGTERM');
      await settled();
      await settled();
      expect(killed).to.deep.equal([]);
    } finally {
      process.removeListener('SIGTERM', other);
    }
  });
});
