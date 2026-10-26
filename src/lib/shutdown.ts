/**
 * What the process does on SIGTERM and SIGINT: the registered callbacks,
 * then the signal's own end, see `docs/usage/operations.md#shutdown`
 * @module lib/shutdown
 */
import { constants as osConstants } from 'os';

type ShutdownSignal = 'SIGTERM' | 'SIGINT';
const SHUTDOWN_SIGNALS: ShutdownSignal[] = ['SIGTERM', 'SIGINT'];
export type ShutdownCallback = () => void | Promise<void>;

/**
 * How long the shutdown callbacks get before the signal is raised again.
 * The binary sets it from `--shutdown-timeout`.
 */
export const shutdownTimeout = { ms: 20_000 };

const shutdownCallbacks: ShutdownCallback[] = [];
const listeners = new Map<ShutdownSignal, () => void>();
let pending: Promise<void>[] = [];
let shuttingDown = false;

const settle = (fn: ShutdownCallback): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .catch(() => undefined);

/**
 * Run a callback when the process is told to stop. The first registration
 * installs the signal listeners; a callback registered while the shutdown
 * runs is awaited with the others.
 *
 * Once every callback has settled, or the timeout has passed, the signal is
 * raised again for its default action, unless another listener is there to
 * decide.
 *
 * @param cb what to run, awaited when it answers a promise
 */
export function registerProcessShutdown(cb: ShutdownCallback): void {
  if (shuttingDown) {
    pending.push(settle(cb));
    return;
  }
  shutdownCallbacks.push(cb);
  if (listeners.size > 0) return;
  for (const signal of SHUTDOWN_SIGNALS) {
    const listener = (): void => fanOut(signal);
    listeners.set(signal, listener);
    process.prependListener(signal, listener);
  }
}

function fanOut(signal: ShutdownSignal): void {
  const others = process.listenerCount(signal) - 1;
  shuttingDown = true;
  for (const [name, listener] of listeners)
    process.removeListener(name, listener);
  listeners.clear();
  pending = shutdownCallbacks.splice(0).map(settle);
  const drained = (async (): Promise<void> => {
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
  })();
  // Referenced: a callback that hangs on an empty event loop would
  // otherwise end the process with 0 before the signal is raised again
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>(resolve => {
    timer = setTimeout(resolve, shutdownTimeout.ms);
  });
  const exitCode = 128 + osConstants.signals[signal];
  void Promise.race([drained, expired])
    .then(() => {
      clearTimeout(timer);
      if (others > 0) return;
      process.kill(process.pid, signal);
      // Reached only where the default action does not apply, as for PID 1
      process.exit(exitCode);
    })
    .catch(() => process.exit(exitCode));
}
