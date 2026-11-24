/**
 * The passes of the configured plugins, as `ready` reports them: the
 * priority modules one by one, then the rest in parallel, then configApi,
 * and the first failure rejecting `ready`.
 */
import { expect } from 'chai';

import { DM } from '../src/bin';
import pluginPriority from '../src/plugins/priority.json';

const HELLO = '../../test/__plugins__/hello/index.js';
const HELLO_WORLD = '../../dist/plugins/demo/helloworld.js';
const CONFIG_API = '../../dist/plugins/configApi.js';
const MISSING = '../../test/__plugins__/missing/index.js';
const TRUSTED_PROXY = '../../dist/plugins/auth/trustedProxy.js';
const NAMED_TRUSTED_PROXY = `${TRUSTED_PROXY}:tp2:{"trusted_proxy":["10.99.0.1"]}`;

describe('Configured plugin passes', function () {
  const saved: Record<string, string | undefined> = {};
  const originalLoadPlugin = DM.prototype.loadPlugin;
  let events: string[];
  let loads: Promise<boolean>[];

  before(() => {
    for (const k of ['DM_PLUGINS', 'DM_TRUSTED_PROXIES', 'NODE_ENV'])
      saved[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    process.env.DM_TRUSTED_PROXIES = '10.99.0.1';
    // `core/…` resolves against `src` under the test runner, while a plugin
    // can only be loaded here from `dist`: see priorityNamedInstance.test.ts
    pluginPriority.push(TRUSTED_PROXY);
  });

  after(() => {
    pluginPriority.splice(pluginPriority.indexOf(TRUSTED_PROXY), 1);
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  // On the prototype: the constructor starts loading before an instance can
  // be patched
  beforeEach(() => {
    const own: string[] = (events = []);
    const mine: Promise<boolean>[] = (loads = []);
    DM.prototype.loadPlugin = function (
      this: DM,
      entry: string
    ): Promise<boolean> {
      own.push(`start ${entry}`);
      const load = originalLoadPlugin.call(this, entry);
      load.then(
        () => own.push(`end ${entry}`),
        () => own.push(`fail ${entry}`)
      );
      mine.push(load);
      return load;
    };
  });

  // `ready` rejects on the first failure while the other loads go on: none
  // may outlive its test
  afterEach(async () => {
    await Promise.allSettled(loads);
    DM.prototype.loadPlugin = originalLoadPlugin;
  });

  const start = async (plugins: string[]): Promise<DM> => {
    process.env.DM_PLUGINS = plugins.join(';');
    const server = new DM();
    await server.ready;
    return server;
  };

  const failure = async (plugins: string[]): Promise<Error> => {
    process.env.DM_PLUGINS = plugins.join(';');
    const server = new DM();
    try {
      await server.ready;
    } catch (err) {
      expect(server.composed).to.equal(false);
      return err as Error;
    }
    throw new Error('ready resolved');
  };

  it('should load a named priority instance first and configApi last', async () => {
    const server = await start([
      CONFIG_API,
      HELLO,
      HELLO_WORLD,
      NAMED_TRUSTED_PROXY,
    ]);

    expect(events.slice(0, 2)).to.eql([
      `start ${NAMED_TRUSTED_PROXY}`,
      `end ${NAMED_TRUSTED_PROXY}`,
    ]);
    expect(events.slice(-2)).to.eql([
      `start ${CONFIG_API}`,
      `end ${CONFIG_API}`,
    ]);
    expect(events.slice(2, -2)).to.have.members([
      `start ${HELLO}`,
      `end ${HELLO}`,
      `start ${HELLO_WORLD}`,
      `end ${HELLO_WORLD}`,
    ]);

    const names = Object.keys(server.loadedPlugins);
    expect(names[0]).to.equal('tp2');
    expect(names[names.length - 1]).to.equal('configApi');
    expect(server.composed).to.equal(true);
  });

  it('should reject ready and load nothing else when a priority plugin fails', async () => {
    const refused = `${TRUSTED_PROXY}:tp2:["10.99.0.1"]`;
    const err = await failure([HELLO, refused, CONFIG_API]);

    expect(err.message).to.match(
      /^Error loading plugins: Error: Overrides for plugin tp2 .* must be a JSON object/
    );
    expect(events).to.eql([`start ${refused}`, `fail ${refused}`]);
  });

  it('should reject ready and skip configApi when a parallel plugin fails', async () => {
    const err = await failure([CONFIG_API, MISSING, HELLO]);

    expect(err.message).to.match(
      /^Error loading plugins: Error: Failed to load plugin .*missing/
    );
    expect(events).to.include(`fail ${MISSING}`);
    expect(events.filter(e => e.includes(CONFIG_API))).to.eql([]);
  });
});
