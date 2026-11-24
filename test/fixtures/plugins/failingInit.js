/**
 * A plugin whose `init()` fails, and whose `close()` fails too.
 *
 * Counts its calls on `globalThis.failingInit`, which the test reads: the
 * loader imports this file on its own, so the test holds no instance of it.
 *
 * Plain JavaScript on purpose: the loader hands a `--plugin` entry to
 * `import()` as written, and a `.js` specifier pointing at a `.ts` file is
 * not resolved by every runner.
 */
export default class FailingInit {
  constructor(server) {
    this.server = server;
    this.name = 'failingInit';
    globalThis.failingInit = { init: 0, close: 0, routed: false };
  }

  init() {
    globalThis.failingInit.init++;
    return Promise.reject(new Error('init: resource refused'));
  }

  close() {
    globalThis.failingInit.close++;
    throw new Error('close: nothing to let go of');
  }

  api() {
    globalThis.failingInit.routed = true;
  }
}
