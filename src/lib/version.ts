import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** `start` and the three directories above it */
const SEARCH_DEPTH = 4;

/**
 * The version of this package, read from the `package.json` that ships with
 * it: the repository root when run from the sources, the installed package
 * when run from the bundle. A build that moved the file elsewhere leaves it
 * unknown rather than guessing.
 *
 * `start` is the directory the walk begins from; it defaults to this
 * module's own and exists so the walk can be exercised on a fixture.
 */
export function readVersion(
  start: string = dirname(fileURLToPath(import.meta.url))
): string | undefined {
  let dir = start;
  for (let depth = 0; depth < SEARCH_DEPTH; depth++) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        // The first package.json met is the package's own only where it
        // names this package: a dependency's would claim its version. A
        // package.json that cannot be read says nothing about the ones
        // above it, so the walk goes on.
        const version = pkg.name === 'ldap-rest' ? pkg.version?.trim() : '';
        if (version) return version;
      } catch {
        // Unparsable: keep looking above
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The server's version, as its package declares it */
export const SERVER_VERSION: string | undefined = readVersion();
