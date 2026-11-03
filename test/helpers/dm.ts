/**
 * A server with every option declared, as the monolith always provided.
 *
 * The umbrella's default template carries the core options only: the command
 * line composes the plugins it names. A test constructs its server directly,
 * so it takes the complete set instead of naming every plugin in `argv`.
 */
import type { ConfigTemplate } from '@ldap-rest/core/lib/parseConfig';
import { toConfigEntries } from '@ldap-rest/core/config/options';
import type { OptionSet } from '@ldap-rest/core/config/options';

import { DM as UmbrellaDM } from '../../src/bin';
import { coreOptions, withoutCoreDuplicates } from '../../src/coreOptions';
import configArgs from '../../src/options.full';

export class DM extends UmbrellaDM {
  constructor(options: ConfigTemplate = configArgs) {
    super(options);
  }
}

/** A plugin class, as the option composition reads it */
interface PluginClass {
  optionDefinitions?: OptionSet;
}

/** The core options plus the declarations of the plugins a test registers */
export function optionsFor(...plugins: PluginClass[]): ConfigTemplate {
  return withoutCoreDuplicates([
    ...coreOptions,
    ...plugins.flatMap(plugin =>
      toConfigEntries(plugin.optionDefinitions ?? {})
    ),
  ]);
}
