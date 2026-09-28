import Plugin from '../../../dist/abstract/plugin.js';

/** A plugin whose startup check needs I/O, and fails */
class RefusedComposition extends Plugin {
  name = 'refusedComposition';

  async assertComposition() {
    await new Promise(resolve => setImmediate(resolve));
    throw new Error('refusedComposition: the service is unreachable');
  }
}

export { RefusedComposition as default };
