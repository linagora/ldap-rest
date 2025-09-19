import { expect } from 'chai';
import { ConfigParser } from '../../src/lib/parseConfig';
import configArgs from '../../src/config/args';

describe('ConfigParser', () => {
  afterEach(() => {
    delete process.env.DM_LLNG_INI;
    delete process.env.DM_PORT;
    delete process.env.DM_PLUGINS;
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

  it('should parse array from env variable', () => {
    process.env.DM_PLUGINS = 'a,b, c  d';
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(['node', 'script.js']);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['a', 'b', 'c', 'd']);
  });

  it('should parse array from CLI argument', () => {
    const argv = [
      'node',
      'script.js',
      '--plugin',
      'x',
      '--plugin',
      'y',
      '--plugin',
      'z',
    ];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['x', 'y', 'z']);
  });

  it('should combine array from env and CLI', () => {
    process.env.DM_PLUGINS = 'a,b';
    const argv = ['node', 'script.js', '--plugin', 'x', '--plugin', 'y'];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['a', 'b', 'x', 'y']);
  });

  it('should parse command line argument with plural suffix for arrays', () => {
    const argv = ['node', 'script.js', '--plugins', 'm, n  o'];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['m', 'n', 'o']);
  });

  it('should combine plural CLI array with singular CLI array', () => {
    const argv = [
      'node',
      'script.js',
      '--plugins',
      'm, n',
      '--plugin',
      'x',
      '--plugin',
      'y',
    ];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['x', 'y', 'm', 'n']);
  });

  it('should combine plural CLI array with env array', () => {
    process.env.DM_PLUGINS = 'a,b';
    const argv = ['node', 'script.js', '--plugins', 'm, n  o'];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['a', 'b', 'm', 'n', 'o']);
  });

  it('should combine plural CLI array with env and singular CLI arrays', () => {
    process.env.DM_PLUGINS = 'a,b';
    const argv = [
      'node',
      'script.js',
      '--plugins',
      'm, n',
      '--plugin',
      'x',
      '--plugin',
      'y',
    ];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('plugin').that.is.an('array');
    expect(result.plugin).to.deep.equal(['a', 'b', 'x', 'y', 'm', 'n']);
  });

  it('should store additional command-line args', () => {
    const argv = [
      'node',
      'script.js',
      '--plugins',
      'm, n',
      '--zig-zag',
      'test',
    ];
    const parser = new ConfigParser(configArgs);
    const result = parser.parse(argv);
    expect(result).to.have.property('zig_zag').that.equals('test');
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
