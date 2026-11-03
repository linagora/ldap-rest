/**
 * The core options, with the host paths the core cannot know: the shipped
 * schema directory and the umbrella's version.
 *
 * `src/options.ts` and `src/options.full.ts` both start from here so the two
 * cannot drift. See `docs/development/modularization-plan.md`.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import coreConfigArgs from '@ldap-rest/core/config/args';
import type {
  ConfigEntry,
  ConfigTemplate,
} from '@ldap-rest/core/lib/parseConfig';
import { setShippedSchemasPath } from '@ldap-rest/core/lib/schemaFile';
import { setServerVersion } from '@ldap-rest/core/lib/version';

export const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(here, '..');
export const shippedSchemas = join(packageRoot, 'static', 'schemas');

setShippedSchemasPath(shippedSchemas);
setServerVersion(
  (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    }
  ).version
);

export const coreOptions: ConfigTemplate = coreConfigArgs.map(entry =>
  entry[0] === '--schemas-path'
    ? ([entry[0], entry[1], shippedSchemas, ...entry.slice(3)] as ConfigEntry)
    : entry
);

/** Drop a plugin's copy of an option the core already declares */
export function withoutCoreDuplicates(config: ConfigTemplate): ConfigTemplate {
  const seen = new Set<string>();
  return config.filter(entry => {
    if (seen.has(entry[0])) return false;
    seen.add(entry[0]);
    return true;
  });
}
