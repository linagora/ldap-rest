import { expect } from 'chai';

import { ConfigParser } from '../../src/lib/parseConfig';
import configArgs from '../../src/config/args';
import {
  defineOptions,
  opt,
  readOptions,
  unknownEnvironmentOptions,
} from '../../src/config/options';
import { DM } from '../../src/bin';

describe('unknown options', () => {
  it('keeps the CLI arguments no entry declares', () => {
    const parser = new ConfigParser(configArgs);
    const config = parser.parse([
      'node',
      'ldap-rest',
      '--not-an-option',
      'value',
      '--port',
      '8080',
    ]);
    expect(parser.unknownOptions).to.deep.equal(['--not-an-option']);
    expect(
      (config as unknown as Record<string, unknown>).not_an_option
    ).to.equal('value');
  });

  it('names the DM_* variables no entry reads', () => {
    expect(
      unknownEnvironmentOptions(configArgs, {
        DM_PORT: '8080',
        DM_NOT_AN_OPTION: 'x',
        DM_TEST_HELPER: 'y',
      })
    ).to.deep.equal(['DM_NOT_AN_OPTION']);
  });

  it('reads a declared environment variable the parser did not carry', () => {
    const saved = process.env.DM_EXT_URL;
    process.env.DM_EXT_URL = 'https://example.com';
    try {
      const definitions = defineOptions({
        ext_url: opt.string({ env: 'DM_EXT_URL', default: '' }),
      });
      expect(readOptions(definitions, {}).ext_url).to.equal(
        'https://example.com'
      );
    } finally {
      if (saved === undefined) delete process.env.DM_EXT_URL;
      else process.env.DM_EXT_URL = saved;
    }
  });

  it('refuses an unknown variable with --strict-options', async () => {
    const saved = {
      DM_STRICT_OPTIONS: process.env.DM_STRICT_OPTIONS,
      DM_NOT_AN_OPTION: process.env.DM_NOT_AN_OPTION,
    };
    process.env.DM_STRICT_OPTIONS = 'true';
    process.env.DM_NOT_AN_OPTION = 'x';
    try {
      let error: Error | undefined;
      try {
        await new DM().ready;
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).to.match(
        /Unknown configuration: .*DM_NOT_AN_OPTION/
      );
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });
});
