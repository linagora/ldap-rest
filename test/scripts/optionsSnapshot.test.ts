import { expect } from 'chai';
import { readFileSync } from 'fs';

import {
  buildOptionsSnapshot,
  diffOptionsSnapshot,
  nonAdditive,
  SNAPSHOT_PATH,
  serializeOptionsSnapshot,
} from '../../scripts/options-snapshot';
import configArgs from '../../src/config/args';
import type { ConfigEntry } from '../../src/lib/parseConfig';

const config: ConfigEntry[] = [
  ['--port', 'DM_PORT', 8081, 'number'],
  [
    '--plugin',
    'DM_PLUGINS',
    [],
    'array',
    '--plugins',
    'identifiers',
    true,
    ['--old-plugin'],
    ['DM_OLD_PLUGINS'],
  ],
];

describe('Options snapshot', () => {
  it('sorts the options and names the repository instead of its path', () => {
    const repository = '/build/ldap-rest';
    const entries: ConfigEntry[] = [
      ['--z-last', 'DM_Z_LAST', '/build/ldap-rest/static', 'string'],
      ['--a-first', 'DM_A_FIRST', false, 'boolean'],
    ];
    const snapshot = buildOptionsSnapshot(entries, repository);

    expect(snapshot.map(option => option.cli)).to.deep.equal([
      '--a-first',
      '--z-last',
    ]);
    expect(snapshot[1].default).to.equal('<repo>/static');
  });

  it('keeps the type, default, plural form, aliases and required flag', () => {
    const snapshot = buildOptionsSnapshot(config, '/build/ldap-rest');
    const port = snapshot.find(option => option.cli === '--port');
    const plugin = snapshot.find(option => option.cli === '--plugin');

    expect(port).to.deep.equal({
      cli: '--port',
      type: 'number',
      default: 8081,
      env: 'DM_PORT',
    });
    expect(plugin).to.deep.include({
      cli: '--plugin',
      type: 'array',
      plural: '--plugins',
      kind: 'identifiers',
      required: true,
      aliases: ['--old-plugin'],
      envAliases: ['DM_OLD_PLUGINS'],
    });
  });

  it('serializes the same options to the same bytes', () => {
    const once = serializeOptionsSnapshot(
      buildOptionsSnapshot(config, '/build/ldap-rest')
    );
    const twice = serializeOptionsSnapshot(
      buildOptionsSnapshot(config, '/build/ldap-rest')
    );
    expect(once).to.equal(twice);
  });

  it('treats an added option as additive and a removed one as not', () => {
    const base = buildOptionsSnapshot(config, '/build/ldap-rest');
    const added = buildOptionsSnapshot(
      [...config, ['--new', 'DM_NEW', 'x', 'string']],
      '/build/ldap-rest'
    );
    const removed = buildOptionsSnapshot([config[0]], '/build/ldap-rest');

    expect(nonAdditive(diffOptionsSnapshot(base, added))).to.deep.equal([]);
    expect(diffOptionsSnapshot(base, added)).to.deep.include({
      kind: 'added',
      what: 'option --new',
      detail: 'DM_NEW',
    });
    expect(nonAdditive(diffOptionsSnapshot(base, removed))).to.deep.include({
      kind: 'removed',
      what: 'option --plugin',
    });
  });

  it('refuses a changed type, default, variable or plural form', () => {
    const base = buildOptionsSnapshot(config, '/build/ldap-rest');
    const changed = buildOptionsSnapshot(
      [
        ['--port', 'DM_PORT', 9090, 'string'],
        [
          config[1][0],
          'DM_PLUGIN_LIST',
          [],
          'array',
          '--plugin-list',
          'identifiers',
        ],
      ],
      '/build/ldap-rest'
    );
    const details = nonAdditive(diffOptionsSnapshot(base, changed)).map(
      difference => difference.detail
    );

    expect(details).to.deep.include('type: "number" → "string"');
    expect(details).to.deep.include('default: 8081 → 9090');
    expect(details).to.deep.include(
      'env: "DM_PLUGINS" → "DM_PLUGIN_LIST" without an alias'
    );
    expect(details).to.deep.include('plural: "--plugins" → "--plugin-list"');
  });

  it('treats an added alias as additive and a removed one as not', () => {
    const base = buildOptionsSnapshot(config, '/build/ldap-rest');
    const withAlias = buildOptionsSnapshot(
      [
        config[0],
        [
          config[1][0],
          'DM_PLUGINS',
          [],
          'array',
          '--plugins',
          'identifiers',
          true,
          ['--old-plugin', '--older-plugin'],
          ['DM_OLD_PLUGINS'],
        ],
      ],
      '/build/ldap-rest'
    );
    const withoutAlias = buildOptionsSnapshot(
      [
        config[0],
        [
          config[1][0],
          'DM_PLUGINS',
          [],
          'array',
          '--plugins',
          'identifiers',
          true,
          undefined,
          ['DM_OLD_PLUGINS'],
        ],
      ],
      '/build/ldap-rest'
    );

    expect(nonAdditive(diffOptionsSnapshot(base, withAlias))).to.deep.equal([]);
    expect(
      nonAdditive(diffOptionsSnapshot(base, withoutAlias))
    ).to.deep.include({
      kind: 'changed',
      what: 'option --plugin',
      detail: 'aliases: --old-plugin removed',
    });
  });

  it('reads a renamed option kept as an alias as a deprecation', () => {
    const base = buildOptionsSnapshot(
      [['--old-name', 'DM_OLD_NAME', 'x', 'string']],
      '/build/ldap-rest'
    );
    const renamed = buildOptionsSnapshot(
      [
        [
          '--new-name',
          'DM_NEW_NAME',
          'x',
          'string',
          undefined,
          undefined,
          false,
          ['--old-name'],
          ['DM_OLD_NAME'],
        ],
      ],
      '/build/ldap-rest'
    );

    expect(nonAdditive(diffOptionsSnapshot(base, renamed))).to.deep.equal([]);
    expect(diffOptionsSnapshot(base, renamed)).to.deep.include({
      kind: 'added',
      what: 'option --new-name',
      detail: 'DM_NEW_NAME',
    });
  });

  it('reports a rename that drops the old environment variable', () => {
    const base = buildOptionsSnapshot(
      [['--old-name', 'DM_OLD_NAME', 'x', 'string']],
      '/build/ldap-rest'
    );
    const renamed = buildOptionsSnapshot(
      [
        [
          '--new-name',
          'DM_NEW_NAME',
          'x',
          'string',
          undefined,
          undefined,
          false,
          ['--old-name'],
        ],
      ],
      '/build/ldap-rest'
    );

    expect(nonAdditive(diffOptionsSnapshot(base, renamed))).to.deep.include({
      kind: 'changed',
      what: 'option --new-name',
      detail: 'env: "DM_OLD_NAME" → "DM_NEW_NAME" without an alias',
    });
  });

  it('reports a type change hidden by a rename', () => {
    const base = buildOptionsSnapshot(
      [['--old-name', 'DM_OLD_NAME', 'x', 'string']],
      '/build/ldap-rest'
    );
    const renamed = buildOptionsSnapshot(
      [
        [
          '--new-name',
          'DM_OLD_NAME',
          1,
          'number',
          undefined,
          undefined,
          false,
          ['--old-name'],
        ],
      ],
      '/build/ldap-rest'
    );

    expect(nonAdditive(diffOptionsSnapshot(base, renamed))).to.deep.include({
      kind: 'changed',
      what: 'option --new-name',
      detail: 'type: "string" → "number"',
    });
  });

  it('keeps the committed snapshot up to date', () => {
    const committed = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(committed).to.equal(
      serializeOptionsSnapshot(buildOptionsSnapshot(configArgs))
    );
  });
});
