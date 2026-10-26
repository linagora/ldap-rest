/**
 * A process that registers a shutdown callback and waits for a signal; the
 * mode in argv[2] decides how the callback behaves. Run by
 * test/lib/processShutdown.test.ts.
 */
import {
  registerProcessShutdown,
  shutdownTimeout,
} from '../../src/lib/shutdown';

const mode = process.argv[2] ?? 'closes';
const say = (what: string): void => {
  process.stdout.write(`${what}\n`);
};
shutdownTimeout.ms = 300;

// Registered before ours, and self-removing: the case a listener that ran
// first would no longer see
if (mode === 'host')
  process.once('SIGTERM', () => {
    setTimeout(() => process.exit(7), 100);
  });

registerProcessShutdown(async () => {
  say('closing');
  if (mode === 'throws') throw new Error('broker already gone');
  if (mode === 'hangs') await new Promise(() => undefined);
  if (mode === 'late')
    registerProcessShutdown(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      say('late');
    });
  await new Promise(resolve => setTimeout(resolve, 50));
  say('closed');
});

setInterval(() => undefined, 1000);
say('ready');
