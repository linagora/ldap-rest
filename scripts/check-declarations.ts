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

// The sub-paths that publish declarations; the `./schema-*` entries are JSON.
const entries = Object.entries(
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    .exports as Record<string, { types?: string }>
).filter(([, target]) => target.types);

const consumer = `import DmPlugin, { HttpError } from 'ldap-rest/plugin';
import { escapeLdapFilter } from 'ldap-rest';
import type { ScimUser } from 'ldap-rest/hooks';
${entries
  .map(([subpath], index) => {
    const name = subpath === '.' ? 'ldap-rest' : `ldap-rest${subpath.slice(1)}`;
    return `import type * as entry${index} from '${name}';`;
  })
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
 * Link the packages a consumer that installs only the runtime dependencies
 * gets, so a type the declarations need from a devDependency is missing here
 * too. Nested copies are flattened: type resolution needs one version.
 */
function linkRuntimeDependencies(modules: string): void {
  const lock = JSON.parse(
    readFileSync(path.join(root, 'package-lock.json'), 'utf8')
  ) as { packages: Record<string, { dev?: boolean }> };
  const packages = new Map<string, string>();
  for (const [where, meta] of Object.entries(lock.packages)) {
    if (!where.startsWith('node_modules/') || meta.dev) continue;
    if (!existsSync(path.join(root, where))) continue;
    const name = where.slice(
      where.lastIndexOf('node_modules/') + 'node_modules/'.length
    );
    if (!packages.has(name) || where === `node_modules/${name}`)
      packages.set(name, where);
  }
  for (const [name, where] of packages) {
    const link = path.join(modules, name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(root, where), link, 'dir');
  }
}

function main(): void {
  const dist = path.join(root, 'dist');
  if (!existsSync(path.join(dist, 'src', 'bin', 'index.d.ts'))) {
    console.error(
      'dist/ holds no declarations: run `npm run build` before this check.'
    );
    process.exitCode = 1;
    return;
  }

  const extensionless = declarationFiles(dist).flatMap(file =>
    specifiers(readFileSync(file, 'utf8'))
      .filter(specifier => !/\.(js|json|css)$/.test(specifier))
      .map(specifier => `${path.relative(root, file)}: ${specifier}`)
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
    linkRuntimeDependencies(modules);
    // Copy rather than link the package: its own location must not bring the
    // repository's devDependencies back into resolution.
    const packageDir = path.join(modules, 'ldap-rest');
    mkdirSync(packageDir, { recursive: true });
    cpSync(path.join(root, 'dist'), path.join(packageDir, 'dist'), {
      recursive: true,
    });
    copyFileSync(
      path.join(root, 'package.json'),
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
  } catch {
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
