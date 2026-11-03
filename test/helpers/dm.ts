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
import {
  optionDefinitionsOf,
  optionDependenciesOf,
} from '@ldap-rest/core/config/pluginOptions';

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
  optionDependencies?: readonly string[];
}

/**
 * The core options plus the declarations of the plugins a test registers,
 * following their `optionDependencies` as `composeOptions` does. `dependencies`
 * maps a module name to its class, so a test names every module the plugins
 * depend on even when it declares no options.
 */
export function optionsFor(
  plugins: readonly PluginClass[],
  dependencies: Record<string, PluginClass> = {}
): ConfigTemplate {
  const queue = [...plugins];
  const seen = new Set<PluginClass>();
  const config: ConfigTemplate = [...coreOptions];
  while (queue.length > 0) {
    const plugin = queue.shift() as PluginClass;
    if (seen.has(plugin)) continue;
    seen.add(plugin);
    config.push(...toConfigEntries(optionDefinitionsOf(plugin)));
    for (const module of optionDependenciesOf(plugin)) {
      const dependency = dependencies[module];
      if (!dependency)
        throw new Error(
          `optionsFor: pass ${module} in the dependencies of the test`
        );
      queue.push(dependency);
    }
  }
  return withoutCoreDuplicates(config);
}
