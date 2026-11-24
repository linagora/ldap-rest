/**
 * A plugin whose `init()` fails is closed at once, so it lets go of what it
 * opened in one place, and the startup fails with the `init()` error even
 * when that `close()` fails as well.
 */
import { expect } from 'chai';

import DmPlugin from '../../src/abstract/plugin';
import { DM } from '../../src/bin';

const FAILING = '../../test/fixtures/plugins/failingInit.js';

interface Calls {
  init: number;
  close: number;
  routed: boolean;
}

const KEYS = ['DM_PLUGINS', 'NODE_ENV'];

describe('A plugin whose init() fails', () => {
  const env: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) env[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    delete process.env.DM_PLUGINS;
  });

  afterEach(() => {
    delete (globalThis as { failingInit?: Calls }).failingInit;
    for (const [k, v] of Object.entries(env))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('is closed once, and ready rejects with the init error', async () => {
    process.env.DM_PLUGINS = FAILING;
    const server = new DM();
    // Loading starts with an import, so the spy is in place before it ends
    const warnings: string[] = [];
    const warn = server.logger.warn.bind(server.logger);
    server.logger.warn = ((line: string, ...rest: unknown[]) => {
      warnings.push(String(line));
      return warn(line, ...rest);
    }) as typeof server.logger.warn;
    let refused: Error | undefined;
    await server.ready.catch((err: Error) => {
      refused = err;
    });
    const calls = (globalThis as { failingInit?: Calls }).failingInit;
    expect(calls, 'the fixture was loaded').to.not.equal(undefined);
    expect(calls!.init, 'init').to.equal(1);
    expect(calls!.close, 'close').to.equal(1);
    expect(calls!.routed, 'routes mounted').to.equal(false);
    expect(refused, 'ready rejected').to.be.instanceOf(Error);
    expect(refused!.message).to.match(/init: resource refused/);
    expect(refused!.message).to.not.match(/close:/);
    expect(warnings).to.include(
      'failingInit: close failed after a failed init: close: nothing to let go of'
    );
    expect(server.loadedPlugins).to.not.have.property('failingInit');
  });

  it('rejects registerPlugin with the init error, after closing', async () => {
    const server = new DM();
    await server.ready;
    const refusal = new Error('init: not now');
    const events: string[] = [];
    class Failing extends DmPlugin {
      name = 'failing';
      init(): Promise<void> {
        events.push('init');
        return Promise.reject(refusal);
      }
      close(): void {
        events.push('close');
      }
    }
    let refused: unknown;
    await server
      .registerPlugin('failing', new Failing(server))
      .catch((err: unknown) => (refused = err));
    expect(refused).to.equal(refusal);
    expect(events).to.deep.equal(['init', 'close']);
    expect(server.loadedPlugins).to.not.have.property('failing');
  });
});
