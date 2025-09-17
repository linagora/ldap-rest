import { expect } from 'chai';
import {
  ConfigParser,
  parseConfig,
  ConfigEntry,
} from '../../src/lib/parseConfig';

describe('ConfigParser', () => {
  const config: ConfigEntry[] = [
    { cliArg: '--foo', envVar: 'FOO', defaultValue: 'bar' },
    { cliArg: '--baz', envVar: 'BAZ', defaultValue: 42, isInteger: true },
    {
      cliArg: '--flag',
      envVar: 'FLAG',
      defaultValue: false,
      isBoolean: true,
    },
    { cliArg: '-s', envVar: 'SHORT', defaultValue: 'short' },
  ];

  afterEach(() => {
    delete process.env.FOO;
    delete process.env.BAZ;
    delete process.env.FLAG;
    delete process.env.SHORT;
  });

  it('should use default values when no env or cli args', () => {
    const parser = new ConfigParser(config);
    const result = parser.parse(['node', 'script.js']);
    expect(result.foo).to.equal('bar');
    expect(result.baz).to.equal(42);
    expect(result.flag).to.equal(false);
    expect(result.s).to.equal('short');
  });

  it('should override with environment variables', () => {
    process.env.FOO = 'envfoo';
    process.env.BAZ = '100';
    process.env.FLAG = 'true';
    process.env.SHORT = 'envshort';
    const parser = new ConfigParser(config);
    const result = parser.parse(['node', 'script.js']);
    expect(result.foo).to.equal('envfoo');
    expect(result.baz).to.equal('100');
    expect(result.flag).to.equal(true);
    expect(result.s).to.equal('envshort');
  });

  it('should override with CLI arguments', () => {
    const argv = [
      'node',
      'script.js',
      '--foo',
      'clifoo',
      '--baz',
      '77',
      '--flag',
      '-s',
      'clishort',
    ];
    const parser = new ConfigParser(config);
    const result = parser.parse(argv);
    expect(result.foo).to.equal('clifoo');
    expect(result.baz).to.equal(77);
    expect(result.flag).to.equal(true);
    expect(result.s).to.equal('clishort');
  });

  it('should prioritize CLI over env', () => {
    process.env.FOO = 'envfoo';
    process.env.BAZ = '100';
    process.env.FLAG = 'false';
    const argv = [
      'node',
      'script.js',
      '--foo',
      'clifoo',
      '--baz',
      '77',
      '--flag',
    ];
    const parser = new ConfigParser(config);
    const result = parser.parse(argv);
    expect(result.foo).to.equal('clifoo');
    expect(result.baz).to.equal(77);
    expect(result.flag).to.equal(true);
  });

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
});
