/**
 * The options the core and a plugin family both declare.
 *
 * `withoutCoreDuplicates` keeps the core entry, so the two copies must agree;
 * otherwise a default or environment variable changed on the plugin side
 * would be ignored without a word.
 */
import coreConfigArgs from '@ldap-rest/core/config/args';
import type { ConfigEntry } from '@ldap-rest/core/lib/parseConfig';
import { expect } from 'chai';

import { pluginConfigArgs } from '../../src/options.full';

/** Compare the entries as the parser reads them, shorthand or not */
const effective = (entry: ConfigEntry): unknown[] => [
  entry[0],
  entry[1] ?? '',
  entry[2],
  entry[3] ?? 'string',
  entry[4] ?? undefined,
  entry[5] ?? undefined,
  Boolean(entry[6]),
  entry[7] ?? undefined,
  entry[8] ?? undefined,
];

const core = new Map(coreConfigArgs.map(entry => [entry[0], entry]));
const shared = pluginConfigArgs.filter(entry => core.has(entry[0]));

describe('shared options', () => {
  it('has copies to compare', () => {
    expect(shared.length).to.be.greaterThan(0);
  });

  for (const entry of shared)
    it(`declares ${entry[0]} as the core does`, () => {
      const coreEntry = core.get(entry[0]) as ConfigEntry;
      expect(effective(entry)).to.deep.equal(effective(coreEntry));
    });
});
