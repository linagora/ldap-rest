/**
 * The JSON schemas LDAP-Rest ships, and where they live.
 *
 * A plugin that names one of them when its options are read joins this
 * directory rather than searching the tree: the package is the one that
 * ships the file. The umbrella composes a copy at build time, which the
 * static plugin serves, and the plugins name that copy when it exists.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The `static/schemas` directory this package ships. */
export const schemasPath = join(packageRoot, 'static', 'schemas');

/**
 * The `static/schemas` directory the deployment serves: the repository root
 * when this package runs from its sources, the `ldap-rest` package beside the
 * `@ldap-rest` scope once installed.
 *
 * It does not depend on the tree being composed: the Dockerfile is generated
 * from the default paths before a build, and it must name the copy the
 * tarball ships.
 *
 * @returns the served directory, undefined when no umbrella is installed
 */
export const servedSchemasPath = (): string | undefined => {
  for (let here = packageRoot; ; here = dirname(here)) {
    const manifest = join(here, 'package.json');
    if (existsSync(manifest)) {
      try {
        const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string;
        };
        if (name === 'ldap-rest') return join(here, 'static', 'schemas');
      } catch {
        // An unreadable manifest is not the umbrella: keep looking upwards
      }
    }
    if (dirname(here) === here) break;
  }
  // Installed: <modules>/@ldap-rest/schemas → <modules>/ldap-rest/static/schemas
  const installed = join(
    packageRoot,
    '..',
    '..',
    'ldap-rest',
    'static',
    'schemas'
  );
  return existsSync(installed) ? installed : undefined;
};
