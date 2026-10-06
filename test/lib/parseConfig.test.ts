import { expect } from 'chai';
import { ConfigParser } from '../../src/lib/parseConfig';
import configArgs from '../../src/config/args';

describe('ConfigParser', () => {
  // test/setup.ts sets some DM_* variables for the whole run: give each test
  // the environment it found
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
  });
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
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

  describe('array options from the environment', () => {
    const parse = () =>
      new ConfigParser(configArgs).parse(['node', 'script.js']);

    // The defaults are those of the code, not of the test setup
    beforeEach(() => {
      for (const key of Object.keys(process.env))
        if (key.startsWith('DM_')) delete process.env[key];
    });

    it('should keep the default for an empty variable', () => {
      const expected = parse().group_class;
      expect(expected).to.not.deep.equal([]);
      process.env.DM_GROUP_CLASSES = '';
      expect(parse().group_class).to.deep.equal(expected);
    });

    it('should keep the default for a whitespace-only variable', () => {
      const expected = parse().group_class;
      process.env.DM_GROUP_CLASSES = ' \t ';
      expect(parse().group_class).to.deep.equal(expected);
    });

    it('should give nothing for an empty variable without default', () => {
      process.env.DM_LDAP_RAW_BASE = '';
      expect(parse().ldap_raw_base).to.deep.equal([]);
    });

    it('should split identifiers on commas and spaces', () => {
      process.env.DM_USER_CLASSES = 'top, a  b,c';
      expect(parse().user_class).to.deep.equal(['top', 'a', 'b', 'c']);
    });

    it('should split identifiers on semicolons and spaces', () => {
      process.env.DM_USER_CLASSES = 'top;a,b c';
      expect(parse().user_class).to.deep.equal(['top', 'a,b', 'c']);
    });

    it('should split on semicolons a value starting with one', () => {
      process.env.DM_USER_CLASSES = ';top;a,b';
      expect(parse().user_class).to.deep.equal(['top', 'a,b']);
      process.env.DM_LDAP_RAW_BASE = ';ou=a b,dc=x; ou=c,dc=y;';
      expect(parse().ldap_raw_base).to.deep.equal(['ou=a b,dc=x', 'ou=c,dc=y']);
    });

    it('should keep the spaces of a DN split on semicolons', () => {
      process.env.DM_LDAP_RAW_BASE = 'ou=My Unit,dc=x;ou=b,dc=y';
      expect(parse().ldap_raw_base).to.deep.equal([
        'ou=My Unit,dc=x',
        'ou=b,dc=y',
      ]);
    });

    it('should keep a single DN without semicolon whole', () => {
      process.env.DM_LDAP_RAW_BASE = ' ou=My Unit,dc=x ';
      expect(parse().ldap_raw_base).to.deep.equal(['ou=My Unit,dc=x']);
    });

    it('should split phrases on newlines', () => {
      process.env.DM_AUTH_HMAC = 'a:s:A B\nc:t:D E\r\nf:u:G';
      expect(parse().auth_hmac).to.deep.equal(['a:s:A B', 'c:t:D E', 'f:u:G']);
      process.env.DM_AUTH_TOTP =
        'JBSWY3DPEHPK3PXP:John Doe:6\nHXDMVJECJJWSRB3H:b';
      expect(parse().auth_totp).to.deep.equal([
        'JBSWY3DPEHPK3PXP:John Doe:6',
        'HXDMVJECJJWSRB3H:b',
      ]);
    });

    it('should split tokens on spaces and commas', () => {
      process.env.DM_AUTH_TOKENS = 't1 t2';
      expect(parse().auth_token).to.deep.equal(['t1', 't2']);
      process.env.DM_AUTH_TOKENS = 'tok1,tok2, tok3:admin,';
      expect(parse().auth_token).to.deep.equal(['tok1', 'tok2', 'tok3:admin']);
    });

    it('should split padded base64 tokens on commas', () => {
      process.env.DM_AUTH_TOKENS = 'YWJj=,ZGVm=';
      expect(parse().auth_token).to.deep.equal(['YWJj=', 'ZGVm=']);
    });

    it('should keep the spaces of an HMAC name', () => {
      process.env.DM_AUTH_HMAC =
        'id:secret:Registration Service,id2:s2:Other Name';
      expect(parse().auth_hmac).to.deep.equal([
        'id:secret:Registration Service',
        'id2:s2:Other Name',
      ]);
      process.env.DM_AUTH_HMAC = 'id:s:A B;id2:s2:C,D';
      expect(parse().auth_hmac).to.deep.equal(['id:s:A B', 'id2:s2:C,D']);
    });

    it('should keep the default for a value without any item', () => {
      const group = parse().group_class;
      const url = parse().ldap_url;
      process.env.DM_GROUP_CLASSES = ',';
      process.env.DM_LDAP_URL = ';';
      process.env.DM_LDAP_RAW_BASE = ' ; ';
      const result = parse();
      expect(result.group_class).to.deep.equal(group);
      expect(result.ldap_url).to.deep.equal(url);
      expect(result.ldap_raw_base).to.deep.equal([]);
    });

    it('should keep the default for an empty number', () => {
      process.env.DM_PORT = '';
      expect(parse().port).to.equal(8081);
      process.env.DM_PORT = ' ';
      expect(parse().port).to.equal(8081);
    });

    it('should keep the default for an empty JSON value', () => {
      const entry = configArgs.find(e => e[3] === 'json');
      expect(entry).to.not.equal(undefined);
      const dflt = new ConfigParser(configArgs).parse(['node', 'script.js']);
      const key = entry![0].replace(/^--/, '').replace(/-/g, '_');
      process.env[entry![1]] = '  ';
      const result = parse();
      expect(result[key as keyof typeof result]).to.deep.equal(
        dflt[key as keyof typeof dflt]
      );
    });

    it('should keep what follows a negative number on the command line', () => {
      const result = new ConfigParser(configArgs).parse([
        'node',
        'script.js',
        '--ldap-cache-max',
        '-1',
        '--plugin',
        'core/x',
      ]);
      expect(result.ldap_cache_max).to.equal(-1);
      expect(result.plugin).to.deep.equal(['core/x']);
    });

    it('should refuse a value that is not a number', () => {
      process.env.DM_PORT = 'abc';
      expect(parse).to.throw(/DM_PORT/);
      delete process.env.DM_PORT;
      const cli =
        (...args: string[]) =>
        () =>
          new ConfigParser(configArgs).parse(['node', 'script.js', ...args]);
      expect(cli('--port', '--log-level', 'debug')).to.throw(/--port/);
      expect(cli('--port', 'abc')).to.throw(/--port/);
      expect(cli('--port', '90')().port).to.equal(90);
    });

    it('should trim a single value alike for every form', () => {
      const cli = (...args: string[]) =>
        new ConfigParser(configArgs).parse(['node', 'script.js', ...args]);
      expect(cli('--ldap-raw-base', ' ou=a ').ldap_raw_base).to.deep.equal([
        'ou=a',
      ]);
      expect(cli('--ldap-raw-bases', ' ou=a ').ldap_raw_base).to.deep.equal([
        'ou=a',
      ]);
    });

    it('should refuse an empty number on the command line', () => {
      expect(() =>
        new ConfigParser(configArgs).parse(['node', 'script.js', '--port', ''])
      ).to.throw(/--port has an empty value/);
    });

    it('should split the plural form like the environment variable', () => {
      const plural = (name: string, value: string) =>
        new ConfigParser(configArgs).parse(['node', 'script.js', name, value]);
      expect(
        plural('--ldap-raw-bases', 'ou=My Unit,dc=x;ou=b,dc=y').ldap_raw_base
      ).to.deep.equal(['ou=My Unit,dc=x', 'ou=b,dc=y']);
      expect(
        plural('--ldap-raw-bases', 'ou=My Unit,dc=x').ldap_raw_base
      ).to.deep.equal(['ou=My Unit,dc=x']);
      expect(plural('--auth-hmacs', 'a:b:C D,e:f:G H').auth_hmac).to.deep.equal(
        ['a:b:C D', 'e:f:G H']
      );
      expect(plural('--auth-tokens', 'a;b,c').auth_token).to.deep.equal([
        'a',
        'b,c',
      ]);
      expect(plural('--auth-tokens', 't1 t2,t3').auth_token).to.deep.equal([
        't1',
        't2',
        't3',
      ]);
      expect(plural('--user-classes', 'a b,c').user_class).to.deep.equal([
        'a',
        'b',
        'c',
      ]);
    });

    it('should split --authz-dynamic-bypass on commas on the CLI', () => {
      const result = new ConfigParser(configArgs).parse([
        'node',
        'script.js',
        '--authz-dynamic-bypass',
        'a,b',
      ]);
      expect(result.authz_dynamic_bypass).to.deep.equal(['a', 'b']);
    });
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

  it('should refuse a second value after an array option', () => {
    // `--authz-for oidc authToken` used to read as `["oidc"]`: a scope
    // smaller than the command line, and requests nobody judges.
    const parser = new ConfigParser(configArgs);
    expect(() =>
      parser.parse(['node', 'script.js', '--authz-for', 'oidc', 'authToken'])
    ).to.throw(
      /--authz-for takes one value, got "oidc" followed by "authToken"/
    );
    expect(() =>
      parser.parse(['node', 'script.js', '--plugin', 'a', 'b'])
    ).to.throw(/or give them all to --plugins/);
  });

  it('should read an array option repeated, or followed by another option', () => {
    const parser = new ConfigParser(configArgs);
    const result = parser.parse([
      'node',
      'script.js',
      '--authz-for',
      'oidc',
      '--authz-for',
      'authToken',
      '--authz-combine',
    ]);
    expect(result.authz_for).to.deep.equal(['oidc', 'authToken']);
    expect(result.authz_combine).to.equal(true);
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

  it('should replace the default with a CLI array, split on commas', () => {
    const parser = new ConfigParser(configArgs);
    for (const argv of [
      ['--group-class', 'top,groupOfNames,twakeGroup'],
      ['--group-classes', 'top,groupOfNames,twakeGroup'],
      ['--group-class', 'top', '--group-class', 'groupOfNames, twakeGroup'],
    ]) {
      const result = parser.parse(['node', 'script.js', ...argv]);
      expect(result.group_class).to.deep.equal([
        'top',
        'groupOfNames',
        'twakeGroup',
      ]);
    }
  });

  it('should keep a DN given to a singular array option whole', () => {
    const parser = new ConfigParser(configArgs);
    const result = parser.parse([
      'node',
      'script.js',
      '--ldap-raw-base',
      'ou=users,dc=example,dc=com',
      '--ldap-raw-base',
      'ou=groups,dc=example,dc=com',
    ]);
    expect(result.ldap_raw_base).to.deep.equal([
      'ou=users,dc=example,dc=com',
      'ou=groups,dc=example,dc=com',
    ]);
  });

  it('should replace the default LDAP URL with comma-separated ones', () => {
    const envUrl = process.env.DM_LDAP_URL;
    delete process.env.DM_LDAP_URL;
    try {
      const parser = new ConfigParser(configArgs);
      const result = parser.parse([
        'node',
        'script.js',
        '--ldap-url',
        'ldap://a,ldap://b',
      ]);
      expect(result.ldap_url).to.deep.equal(['ldap://a', 'ldap://b']);
    } finally {
      if (envUrl !== undefined) process.env.DM_LDAP_URL = envUrl;
    }
  });

  it('should add CLI values to those of the environment variable', () => {
    process.env.DM_GROUP_CLASSES = 'top,groupOfNames';
    const parser = new ConfigParser(configArgs);
    const result = parser.parse([
      'node',
      'script.js',
      '--group-class',
      'twakeGroup,twakeStaticGroup',
    ]);
    expect(result.group_class).to.deep.equal([
      'top',
      'groupOfNames',
      'twakeGroup',
      'twakeStaticGroup',
    ]);
  });

  it('should keep a secret containing a comma whole', () => {
    const parser = new ConfigParser(configArgs);
    const result = parser.parse([
      'node',
      'script.js',
      '--auth-token',
      's3cr,et:admin',
      '--auth-hmac',
      'app:s3cr,et',
      '--auth-totp',
      'app:AB,CD:admin',
    ]);
    expect(result.auth_token).to.deep.equal(['s3cr,et:admin']);
    expect(result.auth_hmac).to.deep.equal(['app:s3cr,et']);
    expect(result.auth_totp).to.deep.equal(['app:AB,CD:admin']);
  });

  it('should refuse an empty array value', () => {
    const parser = new ConfigParser(configArgs);
    for (const argv of [
      ['--group-class', ''],
      ['--group-class', ' , '],
      ['--group-class', 'top', '--group-class', ''],
      ['--group-classes', ''],
      ['--auth-token', ''],
      ['--group-class'],
    ]) {
      expect(() => parser.parse(['node', 'script.js', ...argv])).to.throw(
        /--group-class(es)? has an empty value|--auth-token has an empty value/
      );
    }
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
