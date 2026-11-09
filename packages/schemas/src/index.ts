/**
 * The JSON schemas LDAP-Rest ships, and where they live.
 *
 * A plugin that names one of them when its options are read joins this
 * directory rather than searching the tree: the package is the one that
 * ships the file. The umbrella composes a copy at build time, which the
 * static plugin serves, and the plugins name that copy when it exists.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The `static/schemas` directory this package ships. */
export const schemasPath = join(packageRoot, 'static', 'schemas');

/**
 * The umbrella's own directory, when it is installed: `packages/ldap-rest`
 * in the repository, the `ldap-rest` package beside the `@ldap-rest` scope
 * once installed. Found by looking for its manifest, so a build that has not
 * composed the assets yet still answers the same path.
 */
const umbrellaRoot = (): string | undefined => {
  for (let here = packageRoot; ; here = dirname(here)) {
    for (const candidate of [
      join(here, 'packages', 'ldap-rest'),
      join(here, 'ldap-rest'),
    ])
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(here) === here) return undefined;
  }
};

/**
 * The `static/schemas` directory the deployment serves, when an umbrella
 * ships one.
 *
 * @returns the served directory, undefined when no umbrella is installed
 */
export const servedSchemasPath = (): string | undefined => {
  const umbrella = umbrellaRoot();
  return umbrella ? join(umbrella, 'static', 'schemas') : undefined;
};
