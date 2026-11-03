/**
 * The two-phase read: the `--plugin` entries, then the declarations the named
 * plugins export. The rest of the template is tested with the full option set
 * in `options.test.ts`.
 */
import path from 'path';

import {
  entryModule,
  pluginEntriesFrom,
  pluginOptionEntries,
  resolvePluginModule,
} from '@ldap-rest/core/config/pluginOptions';
import { defineOptions, opt } from '@ldap-rest/core/config/options';
import { expect } from 'chai';

import { composeOptions } from '../../src/options';
import Sample from '../fixtures/pluginOptionSample';

const Dependent = class {
  static optionDefinitions = defineOptions({
    dependent_port: opt.number({ default: 8080 }),
  });
  static optionDependencies = ['core/pluginOptionSample'];
};

const fixtures = path.join(__dirname, '..', 'fixtures');

describe('plugin option entries', () => {
  describe('pluginEntriesFrom', () => {
    it('reads both spellings, one value per occurrence', () => {
      expect(
        pluginEntriesFrom(
          [
            'node',
            'ldap-rest',
            '--plugin',
            'core/metrics',
            '--plugins',
            'core/ldap/groups,core/ldap/raw',
          ],
          {}
        )
      ).to.deep.equal(['core/metrics', 'core/ldap/groups', 'core/ldap/raw']);
    });

    it('reads DM_PLUGINS before the command line, as the parser does', () => {
      expect(
        pluginEntriesFrom(['node', 'ldap-rest', '--plugin', 'a'], {
          DM_PLUGINS: 'b;c',
        })
      ).to.deep.equal(['b', 'c', 'a']);
    });

    it('refuses an empty value', () => {
      expect(() =>
        pluginEntriesFrom(['node', 'ldap-rest', '--plugin'], {})
      ).to.throw(/has an empty value/);
    });
  });

  it('keeps the module part of an entry', () => {
    expect(entryModule('core/metrics:one:{"port":1}')).to.equal('core/metrics');
    expect(entryModule('core/metrics')).to.equal('core/metrics');
  });

  it('resolves core names beside the host and relative ones from its base', () => {
    expect(
      resolvePluginModule('core/metrics', {
        pluginRoot: '/app/plugins',
        resolveBase: '/app/bin',
      })
    ).to.equal('/app/plugins/metrics.js');
    expect(
      resolvePluginModule('./local.js', {
        pluginRoot: '/app/plugins',
        resolveBase: '/app/bin',
      })
    ).to.equal('/app/bin/local.js');
    expect(
      resolvePluginModule('@ldap-rest/twake-james', {
        resolveBase: '/app/bin',
      })
    ).to.equal('@ldap-rest/twake-james');
  });

  it('reads the declarations a named plugin exports', async () => {
    const loaded: string[] = [];
    const entries = await pluginOptionEntries(
      ['core/pluginOptionSample'],
      { pluginRoot: fixtures, resolveBase: fixtures },
      async specifier => {
        loaded.push(specifier);
        return { default: Sample };
      }
    );
    expect(loaded).to.deep.equal([
      path.join(fixtures, 'pluginOptionSample.js'),
    ]);
    expect(entries).to.deep.equal([
      [
        '--sample-timeout',
        'DM_SAMPLE_TIMEOUT',
        5,
        'number',
        undefined,
        undefined,
        false,
      ],
    ]);
  });

  it('imports a module once however often the configuration names it', async () => {
    let loads = 0;
    const entries = await pluginOptionEntries(
      ['core/pluginOptionSample', 'core/pluginOptionSample:second'],
      { pluginRoot: fixtures, resolveBase: fixtures },
      async () => {
        loads++;
        return { default: Sample };
      }
    );
    expect(loads).to.equal(1);
    expect(entries).to.have.length(1);
  });

  it('reads the declarations of what a plugin depends on', async () => {
    const entries = await pluginOptionEntries(
      ['core/pluginDependencySample'],
      { pluginRoot: fixtures, resolveBase: fixtures },
      async specifier =>
        specifier.endsWith('pluginOptionSample.js')
          ? { default: Sample }
          : { default: Dependent }
    );
    expect(entries.map(entry => entry[0])).to.deep.equal([
      '--dependent-port',
      '--sample-timeout',
    ]);
  });

  it('leaves the core template alone when nothing is named', async () => {
    const coreOnly = await composeOptions([]);
    const names = coreOnly.map(entry => entry[0]);
    expect(names).to.include('--plugin');
    expect(names).to.include('--ldap-organization-link-attribute');
    expect(names).to.not.include('--metrics-port');
  });
});
