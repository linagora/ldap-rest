#!/usr/bin/env tsx
/**
 * Check that the declarations the build publishes resolve for a plugin
 * compiled with `moduleResolution: nodenext`.
 *
 * Requires a build: the package entries point at `dist/`. See
 * docs/development/contracts.md.
 *
 * Usage: npm run check:declarations
 */
import { execFileSync } from 'child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const umbrella = path.join(root, 'packages', 'ldap-rest');

// The sub-paths that publish declarations; the `./schema-*` entries are JSON.
const entries = Object.entries(
  JSON.parse(readFileSync(path.join(umbrella, 'package.json'), 'utf8'))
    .exports as Record<string, { types?: string }>
).filter(([, target]) => target.types);

/**
 * The entries of every package, which a deployment installs directly: the
 * consumer imports each one, so a declaration that does not resolve fails
 * here as it would in that deployment.
 */
function packageEntries(): string[] {
  const specifiers: string[] = [];
  for (const entry of readdirSync(path.join(root, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(
      root,
      'packages',
      entry.name,
      'package.json'
    );
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      exports?: Record<string, { types?: string }>;
    };
    if (!manifest.name || manifest.name === 'ldap-rest') continue;
    for (const [subpath, target] of Object.entries(manifest.exports ?? {}))
      // A wildcard entry names a family of modules, not one to import.
      if (target.types && !subpath.includes('*'))
        specifiers.push(
          subpath === '.'
            ? manifest.name
            : `${manifest.name}/${subpath.slice(2)}`
        );
  }
  return specifiers.sort();
}

const consumer = `import DmPlugin, { HttpError } from 'ldap-rest/plugin';
import { escapeLdapFilter } from 'ldap-rest';
import type { ScimUser } from 'ldap-rest/hooks';
${entries
  .map(([subpath], index) => {
    const name = subpath === '.' ? 'ldap-rest' : `ldap-rest${subpath.slice(1)}`;
    return `import type * as entry${index} from '${name}';`;
  })
  .join('\n')}
${packageEntries()
  .map(
    (specifier, index) =>
      `import type * as dependency${index} from '${specifier}';`
  )
  .join('\n')}

// A specifier nodenext cannot resolve turns the import into \`any\`: these
// assignments must stay refused.
// @ts-expect-error HttpError is not a number
const status: number = new HttpError('x', 500);
// @ts-expect-error escapeLdapFilter returns a string
const escaped: number = escapeLdapFilter('a*');
// @ts-expect-error ScimUser is not a number
const user: ScimUser = 42;
type ApiArgument = Parameters<NonNullable<DmPlugin['api']>>[0];
// @ts-expect-error Express is not a number
const apiArgument: ApiArgument = 1;

export class Probe extends DmPlugin {
  name = 'probe';

  probe(): void {
    // @ts-expect-error DM is not a number
    const server: number = this.server;
    void server;
    void status;
    void escaped;
    void user;
    void apiArgument;
  }
}

export type EntryModules = [
${entries.map((_, index) => `  typeof entry${index},`).join('\n')}
];
`;

/** Relative specifiers in a declaration file, as written */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:from|import)\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g,
    /\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.\.?\/[^'"]+)['"]/g,
  ];
  for (const pattern of patterns)
    for (const [, specifier] of source.matchAll(pattern)) found.push(specifier);
  return found;
}

function declarationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return declarationFiles(full);
    return entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * Stage the packages a consumer that installs only the runtime dependencies
 * gets, so a type the declarations need from a devDependency is missing here
 * too. Nested copies are flattened: type resolution needs one version.
 *
 * A workspace package is a link into the repository: copying what it
 * publishes keeps its own location, and the devDependencies beside it, out
 * of the consumer's resolution.
 */
function stageRuntimeDependencies(modules: string): void {
  const lock = JSON.parse(
    readFileSync(path.join(root, 'package-lock.json'), 'utf8')
  ) as {
    packages: Record<
      string,
      { dev?: boolean; link?: boolean; resolved?: string }
    >;
  };
  const packages = new Map<
    string,
    { where: string; link: boolean; resolved?: string }
  >();
  for (const [where, meta] of Object.entries(lock.packages)) {
    if (!where.startsWith('node_modules/') || meta.dev) continue;
    if (!existsSync(path.join(root, where))) continue;
    const name = where.slice(
      where.lastIndexOf('node_modules/') + 'node_modules/'.length
    );
    if (!packages.has(name) || where === `node_modules/${name}`)
      packages.set(name, {
        where,
        link: Boolean(meta.link),
        resolved: meta.resolved,
      });
  }
  for (const [name, entry] of packages) {
    const dest = path.join(modules, name);
    // The umbrella is the package under test: main copies its dist beside
    // the consumer, with the manifest it publishes.
    if (name === 'ldap-rest') continue;
    if (entry.link) {
      const source = path.join(root, entry.resolved ?? '');
      mkdirSync(dest, { recursive: true });
      copyFileSync(
        path.join(source, 'package.json'),
        path.join(dest, 'package.json')
      );
      cpSync(path.join(source, 'dist'), path.join(dest, 'dist'), {
        recursive: true,
      });
      continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(path.join(root, entry.where), dest, 'dir');
  }
}

function main(): void {
  const dist = path.join(umbrella, 'dist');
  if (!existsSync(path.join(dist, 'bin', 'index.d.ts'))) {
    console.error(
      'the umbrella dist/ holds no declarations: run `npm run build` first.'
    );
    process.exitCode = 1;
    return;
  }

  // Every package publishes declarations: one a consumer cannot resolve is a
  // type it silently loses.
  const packageDists = readdirSync(path.join(root, 'packages'), {
    withFileTypes: true,
  })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, 'packages', entry.name, 'dist'))
    .filter(directory => existsSync(directory));
  const extensionless = [dist, ...packageDists].flatMap(directory =>
    declarationFiles(directory).flatMap(file =>
      specifiers(readFileSync(file, 'utf8'))
        .filter(specifier => !/\.(js|json|css)$/.test(specifier))
        .map(specifier => `${path.relative(root, file)}: ${specifier}`)
    )
  );
  if (extensionless.length > 0) {
    console.error('declaration specifiers a nodenext consumer cannot resolve:');
    for (const line of extensionless) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'ldap-rest-nodenext-'));
  try {
    const modules = path.join(workDir, 'node_modules');
    mkdirSync(modules, { recursive: true });
    stageRuntimeDependencies(modules);
    // Copy rather than link the package: its own location must not bring the
    // repository's devDependencies back into resolution.
    const packageDir = path.join(modules, 'ldap-rest');
    mkdirSync(packageDir, { recursive: true });
    cpSync(path.join(umbrella, 'dist'), path.join(packageDir, 'dist'), {
      recursive: true,
    });
    copyFileSync(
      path.join(umbrella, 'package.json'),
      path.join(packageDir, 'package.json')
    );
    writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({ name: 'nodenext-consumer', type: 'module' }, null, 2)
    );
    writeFileSync(
      path.join(workDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            strict: true,
            noEmit: true,
          },
          files: ['consumer.ts'],
        },
        null,
        2
      )
    );
    writeFileSync(path.join(workDir, 'consumer.ts'), consumer);

    execFileSync(
      process.execPath,
      [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', workDir],
      { cwd: root, stdio: 'inherit' }
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      'the published declarations do not type-check under nodenext'
    );
    process.exitCode = 1;
    return;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log('the published declarations resolve under nodenext');
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
