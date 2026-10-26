/**
 * A server run by test/lib/shutdown.test.ts, in a process of its own: the
 * crash policy and the signal policy end the process, which a test cannot
 * survive in-process. The mode in argv[2] decides what happens once it
 * serves: `crash` throws where nothing catches, `crash-hangs` throws with
 * a plugin whose `close()` never settles, `signal` waits for one.
 */
import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';

const mode = process.argv[2] ?? 'crash';
const say = (what: string): void => {
  process.stdout.write(`${what}\n`);
};

const server = new DM();
await server.ready;
server.config.port = 0;
server.config.shutdown_timeout = 3000;
class Holding extends DmPlugin {
  name = 'holding';
  close(): Promise<void> {
    say('closing');
    if (mode === 'crash-hangs') return new Promise(() => undefined);
    say('closed');
    return Promise.resolve();
  }
}
await server.registerPlugin('holding', new Holding(server));
await server.run();
if (mode === 'signal') server.shutdownOnSignals();
else server.exitOnCrash();
say('ready');
if (mode !== 'signal')
  setTimeout(() => {
    throw new Error('boom');
  }, 50);
