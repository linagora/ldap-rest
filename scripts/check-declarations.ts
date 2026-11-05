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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.join(root, 'temp', 'nodenext');

// The sub-paths that publish declarations; the `./schema-*` entries are JSON.
const entries = Object.entries(
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    .exports as Record<string, { types?: string }>
).filter(([, target]) => target.types);

const consumer = `import DmPlugin, { HttpError } from 'ldap-rest/plugin';
import { escapeLdapFilter } from 'ldap-rest';
import type { ScimUser } from 'ldap-rest/plugin-scim-types';
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

export class Probe extends DmPlugin {
  name = 'probe';

  probe(): void {
    // @ts-expect-error DM is not a number
    const server: number = this.server;
    void server;
    void status;
    void escaped;
    void user;
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

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(path.join(workDir, 'node_modules'), { recursive: true });
  symlinkSync(root, path.join(workDir, 'node_modules', 'ldap-rest'), 'dir');
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
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['consumer.ts'],
      },
      null,
      2
    )
  );
  writeFileSync(path.join(workDir, 'consumer.ts'), consumer);

  try {
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
