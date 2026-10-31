import { expect } from 'chai';

import { DM } from '../../src/bin';
import DmPlugin from '../../src/abstract/plugin';
import { serviceToken } from '../../src/lib/services';

interface GreeterApi {
  greet(name: string): string;
}

const GreeterService = serviceToken<GreeterApi>('test-greeter');
const OtherService = serviceToken<GreeterApi>('test-other');

class GreeterProvider extends DmPlugin {
  name = 'greeterProvider';
  greeting = 'hello';
  provides = [
    GreeterService.with({
      greet: name => `${this.greeting} ${name}`,
    }),
  ];
}

class OtherProvider extends DmPlugin {
  name = 'otherProvider';
  provides = [OtherService.with({ greet: name => `other ${name}` })];
}

class GreeterConsumer extends DmPlugin {
  name = 'greeterConsumer';
  lookup = (): GreeterApi | null => this.service(GreeterService);
}

class RequiringConsumer extends DmPlugin {
  name = 'requiringConsumer';
  provides = [OtherService.with({ greet: name => `other ${name}` })];

  assertComposition(): void {
    if (!this.service(GreeterService))
      throw new Error('the greeter service is required');
  }
}

/** Capture what a server logs as warnings. */
function captureWarnings(dm: DM): string[] {
  const warnings: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dm.logger as any).warn = (message: string): unknown => {
    warnings.push(message);
    return dm.logger;
  };
  return warnings;
}

describe('Plugin services', () => {
  it('binds a token to its provider and its name', () => {
    expect(GreeterService.name).to.equal('test-greeter');
    const provider = { greet: (name: string): string => `hello ${name}` };
    const bound = GreeterService.with(provider);
    expect(bound.token).to.equal(GreeterService);
    expect(bound.service).to.equal(provider);
  });

  it('lets a consumer reach a provided service through a withConfig view', async () => {
    const dm = new DM();
    await dm.ready;
    const provider = new GreeterProvider(dm);
    expect(
      await dm.registerPlugin('test/greeter', provider, 'greeter')
    ).to.equal(true);

    // Plugins configured with overrides get a server view: the registry must
    // be the same map, or a consumer would find nothing
    const consumer = new GreeterConsumer(dm.withConfig({ ...dm.config }));
    await dm.registerPlugin('test/consumer', consumer, 'consumer');

    expect(consumer.lookup()?.greet('world')).to.equal('hello world');
    expect(dm.services.get(GreeterService)).to.equal(
      provider.provides[0].service
    );
  });

  it('answers null and warns once when nothing provides the service', async () => {
    const dm = new DM();
    await dm.ready;
    const warnings = captureWarnings(dm);
    const consumer = new GreeterConsumer(dm);

    expect(consumer.lookup()).to.equal(null);
    expect(consumer.lookup()).to.equal(null);

    expect(warnings).to.deep.equal([
      "greeterConsumer: service 'test-greeter' is not provided — its features will be skipped",
    ]);
  });

  it('keeps the first provider and warns when another offers the same token', async () => {
    const dm = new DM();
    await dm.ready;
    const warnings = captureWarnings(dm);
    const first = new GreeterProvider(dm);
    const second = new GreeterProvider(dm);
    second.greeting = 'bonjour';

    await dm.registerPlugin('test/first', first, 'first');
    await dm.registerPlugin('test/second', second, 'second');

    const consumer = new GreeterConsumer(dm);
    expect(consumer.lookup()?.greet('world')).to.equal('hello world');
    expect(warnings).to.deep.equal([
      "Plugin second: service 'test-greeter' is already provided by first; this one is ignored",
    ]);
  });

  it('registers no service from a plugin dropped on a name collision', async () => {
    const dm = new DM();
    await dm.ready;
    const first = new GreeterProvider(dm);
    const dropped = new OtherProvider(dm);

    await dm.registerPlugin('test/first', first, 'greeter');
    expect(await dm.registerPlugin('test/other', dropped, 'greeter')).to.equal(
      false
    );

    expect(dm.services.has(OtherService)).to.equal(false);
  });

  it('refuses a missing service in assertComposition, leaving the plugin out', async () => {
    const provided = new DM();
    await provided.ready;
    await provided.registerPlugin(
      'test/greeter',
      new GreeterProvider(provided),
      'greeter'
    );
    expect(
      await provided.registerPlugin(
        'test/requiring',
        new RequiringConsumer(provided),
        'requiring'
      )
    ).to.equal(true);
    expect(provided.services.has(OtherService)).to.equal(true);

    const missing = new DM();
    await missing.ready;
    let refusal: unknown;
    try {
      await missing.registerPlugin(
        'test/requiring',
        new RequiringConsumer(missing),
        'requiring'
      );
    } catch (err: unknown) {
      refusal = err;
    }
    expect(String(refusal)).to.match(/the greeter service is required/);
    expect(missing.loadedPlugins.requiring).to.equal(undefined);
    expect(missing.services.has(OtherService)).to.equal(false);
  });
});
