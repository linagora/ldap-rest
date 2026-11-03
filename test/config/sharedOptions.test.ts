/**
 * The options the core and a plugin family both declare.
 *
 * `withoutCoreDuplicates` keeps the core entry, so the two copies must agree;
 * otherwise a default or environment variable changed on the plugin side
 * would be ignored without a word.
 */
import coreConfigArgs from '@ldap-rest/core/config/args';
import {
  toConfigEntries,
  type OptionSet,
} from '@ldap-rest/core/config/options';
import type { ConfigEntry } from '@ldap-rest/core/lib/parseConfig';
import { expect } from 'chai';

import {
  enterpriseRulesOptions,
  flatGenericOptions,
  groupsOptions,
  organizationOptions,
  rawOptions,
  trashOptions,
} from '../../src/plugins/ldap/ldap.options';
import { staticOptions } from '../../src/plugins/static.options';

const cli = (key: string): string => `--${key.replace(/_/g, '-')}`;

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

const shared: [string, OptionSet][] = [
  ['ldap_top_organization', organizationOptions],
  ['ldap_organization_link_attribute', organizationOptions],
  ['ldap_organization_path_attribute', organizationOptions],
  ['enterprise_domain_name_attribute', enterpriseRulesOptions],
  ['enterprise_domain_link_attribute', enterpriseRulesOptions],
  ['ldap_group_base', groupsOptions],
  ['group_class', groupsOptions],
  ['group_dummy_user', groupsOptions],
  ['ldap_flat_auto_repair', flatGenericOptions],
  ['ldap_raw_schema_cache_ttl', rawOptions],
  ['trash_base', trashOptions],
  ['static_name', staticOptions],
];

describe('shared options', () => {
  for (const [key, definitions] of shared)
    it(`declares ${key} as the core does`, () => {
      const pluginEntry = toConfigEntries(definitions).find(
        entry => entry[0] === cli(key)
      );
      const coreEntry = coreConfigArgs.find(entry => entry[0] === cli(key));
      expect(coreEntry, `core declares ${key}`).to.not.equal(undefined);
      expect(effective(pluginEntry as ConfigEntry)).to.deep.equal(
        effective(coreEntry as ConfigEntry)
      );
    });
});
