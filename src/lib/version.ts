import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * The version of this package, read from the `package.json` that ships with
 * it: the repository root when run from the sources, the installed package
 * when run from the bundle. A build that moved the file elsewhere leaves it
 * unknown rather than guessing.
 */
function readVersion(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        // The first package.json met is the package's own only where it
        // names this package: a dependency's would claim its version
        if (pkg.name === 'ldap-rest' && pkg.version) return pkg.version;
      } catch {
        return undefined;
      }
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The server's version, as its package declares it */
export const SERVER_VERSION: string | undefined = readVersion();
