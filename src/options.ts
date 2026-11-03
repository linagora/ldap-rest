/**
 * The option set a configuration names: the core options, then the
 * declarations of the plugins its `--plugin` entries load.
 *
 * The core is the only mandatory package; importing every plugin here would
 * make the umbrella depend on all of them. `src/options.full.ts` keeps the
 * complete set for the build scripts and the tests. See
 * `docs/development/modularization-plan.md`.
 */
import { join } from 'path';

import {
  pluginEntriesFrom,
  pluginOptionEntries,
  type PluginRoots,
} from '@ldap-rest/core/config/pluginOptions';
import type { ConfigTemplate } from '@ldap-rest/core/lib/parseConfig';

import { coreOptions, here, withoutCoreDuplicates } from './coreOptions';

export { coreOptions as default } from './coreOptions';

const roots: PluginRoots = {
  pluginRoot: join(here, 'plugins'),
  resolveBase: join(here, 'bin'),
};

/**
 * The core options and the declarations of `entries`, which default to the
 * `--plugin` entries of the command line. A command that needs its feature's
 * options without starting the server names its own plugin entries.
 */
export async function composeOptions(
  entries: readonly string[] = pluginEntriesFrom()
): Promise<ConfigTemplate> {
  return withoutCoreDuplicates([
    ...coreOptions,
    ...(await pluginOptionEntries(entries, roots)),
  ]);
}
