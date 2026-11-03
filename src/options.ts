/**
 * The option set a configuration names: the core options, then the
 * declarations of the plugins its `--plugin` entries load.
 *
 * The core is the only mandatory package; importing every plugin here would
 * make the umbrella depend on all of them. `composeOptions` is the two-phase
 * read, and `src/options.full.ts` keeps the complete set for the build
 * scripts and the option snapshot. See
 * `docs/development/modularization-plan.md`.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import coreConfigArgs from '@ldap-rest/core/config/args';
import {
  pluginEntriesFrom,
  pluginOptionEntries,
  type PluginRoots,
} from '@ldap-rest/core/config/pluginOptions';
import type {
  ConfigEntry,
  ConfigTemplate,
} from '@ldap-rest/core/lib/parseConfig';
import { setShippedSchemasPath } from '@ldap-rest/core/lib/schemaFile';
import { setServerVersion } from '@ldap-rest/core/lib/version';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const shippedSchemas = join(packageRoot, 'static', 'schemas');
setShippedSchemasPath(shippedSchemas);
setServerVersion(
  (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    }
  ).version
);

const roots: PluginRoots = {
  pluginRoot: join(here, 'plugins'),
  resolveBase: join(here, 'bin'),
};

const coreOptions: ConfigTemplate = coreConfigArgs.map(entry =>
  entry[0] === '--schemas-path'
    ? ([entry[0], entry[1], shippedSchemas, ...entry.slice(3)] as ConfigEntry)
    : entry
);

/**
 * The core options and the declarations of `entries`, which default to the
 * `--plugin` entries of the command line. A command that needs its feature's
 * options without starting the server names its own plugin entries.
 */
export async function composeOptions(
  entries: readonly string[] = pluginEntriesFrom()
): Promise<ConfigTemplate> {
  return [...coreOptions, ...(await pluginOptionEntries(entries, roots))];
}

export default coreOptions;
