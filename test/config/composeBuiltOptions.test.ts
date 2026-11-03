/**
 * The composition of the built server, from the plugins a command names.
 *
 * Run against `dist`, as the sources cannot be dynamically imported under
 * `tsx/cjs`. `npm run test:dev` and CI build before testing; without `dist`
 * the suite skips.
 */
import { existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { expect } from 'chai';
import { parseConfig } from '@ldap-rest/core/lib/parseConfig';

import { DM } from '../../src/bin';

interface BuiltOptions {
  composeOptions: (
    entries: readonly string[]
  ) => Promise<Parameters<typeof parseConfig>[0]>;
}

const built = path.join(__dirname, '..', '..', 'dist', 'options.js');

const compose = async (
  entries: readonly string[]
): Promise<Parameters<typeof parseConfig>[0]> => {
  const module = (await import(pathToFileURL(built).href)) as BuiltOptions;
  return module.composeOptions(entries);
};

const names = async (entries: readonly string[]): Promise<string[]> =>
  (await compose(entries)).map(entry => entry[0]);

describe('composeOptions on the built server', () => {
  before(function () {
    if (!existsSync(built)) this.skip();
  });

  it('follows a plugin dependency to read its options', async () => {
    expect(await names(['core/twake/lifecycleEvents'])).to.include(
      '--rabbitmq-url'
    );
    expect(await names(['core/bcl'])).to.include('--storage-sweep-interval');
  });

  it('types a dependency option it read', async () => {
    const config = parseConfig(await compose(['core/bcl']), [
      'node',
      'ldap-rest',
      '--storage-sweep-interval',
      '45',
    ]);
    expect(config.storage_sweep_interval).to.equal(45);
  });

  it('keeps an option the core and the other families read', async () => {
    expect(
      await names(['core/auth/authzPerBranch', 'core/ldap/flatGeneric'])
    ).to.include('--ldap-organization-link-attribute');
    expect(await names(['core/auth/authzScope'])).to.include(
      '--authz-scope-source'
    );
  });

  it('parses a dependency option in the template the command uses', async () => {
    const argv = process.argv;
    process.argv = ['node', 'ldap-rest', '--twake-group-max-page-limit', '12'];
    try {
      const dm = new DM(await compose(['core/twake/spaces']));
      expect(dm.config.twake_group_max_page_limit).to.equal(12);
    } finally {
      process.argv = argv;
    }
  });

  it('declares an option once', async () => {
    const entries = await names([
      'core/twake/lifecycleEvents',
      'core/rabbitmq',
    ]);
    expect(entries.length).to.equal(new Set(entries).size);
  });
});
