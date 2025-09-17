import { expect } from 'chai';
import {
  parseConfig,
  ConfigParser,
  ConfigTemplate,
} from '../../src/lib/parseConfig';
import configArgs from '../../src/config/args';

describe('ConfigParser', () => {
  afterEach(() => {
    delete process.env.DM_LLNG_INI;
    delete process.env.DM_PORT;
  });

  it('should use default values when no env or cli args', () => {
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(['node', 'script.js']);
    expect(result.port).to.equal(8081);
    expect(result.llng_ini).to.equal('/etc/lemonldap-ng/lemonldap-ng.ini');
  });

  it('should override with environment variables', () => {
    process.env.DM_LLNG_INI = '/env/foo';
    process.env.DM_PORT = '100';
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(['node', 'script.js']);
    expect(result.port).to.equal(100);
    expect(result.llng_ini).to.equal('/env/foo');
  });

  it('should override with CLI arguments', () => {
    const argv = [
      'node',
      'script.js',
      '--llng-ini',
      '/cli/foo',
      '--port',
      '77',
    ];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result.llng_ini).to.equal('/cli/foo');
    expect(result.port).to.equal(77);
  });

  it('should prioritize CLI over env', () => {
    process.env.DM_LLNG_INI = '/env/foo';
    process.env.DM_PORT = '100';
    const argv = [
      'node',
      'script.js',
      '--llng-ini',
      '/cli/foo',
      '--port',
      '77',
    ];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result.llng_ini).to.equal('/cli/foo');
    expect(result.port).to.equal(77);
  });

  /*
  it('should handle short CLI args', () => {
    const argv = ['node', 'script.js', '-s', 'shortval'];
    const parser = new ConfigParser(config);
    const result = parser.parse(argv);
    expect(result.s).to.equal('shortval');
  });

  it('should parseConfig as a shortcut', () => {
    const argv = ['node', 'script.js', '--foo', 'shortcut'];
    const result = parseConfig(config, argv);
    expect(result.foo).to.equal('shortcut');
  });

  it('should treat missing integer CLI value as NaN', () => {
    const argv = ['node', 'script.js', '--baz'];
    const parser = new ConfigParser(config);
    const result = parser.parse(argv);
    expect(result.baz).to.be.NaN;
  });

  it('should treat missing boolean CLI value as true', () => {
    const argv = ['node', 'script.js', '--flag'];
    const parser = new ConfigParser(config);
    const result = parser.parse(argv);
    expect(result.flag).to.equal(true);
  });
  */
});
