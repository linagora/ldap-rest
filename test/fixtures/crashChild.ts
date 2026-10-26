/**
 * A server that throws where nothing catches it, once it serves. Run by
 * test/lib/shutdown.test.ts: the crash policy must shut it down and exit
 * with 1.
 */
import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';

const say = (what: string): void => {
  process.stdout.write(`${what}\n`);
};

const server = new DM();
await server.ready;
server.config.port = 0;
server.config.shutdown_timeout = 2000;
class Holding extends DmPlugin {
  name = 'holding';
  close(): void {
    say('closed');
  }
}
await server.registerPlugin('holding', new Holding(server));
await server.run();
say('ready');
setTimeout(() => {
  throw new Error('boom');
}, 50);
