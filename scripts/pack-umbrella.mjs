#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * Pack the umbrella with the packages it bundles.
 *
 * npm bundles the dependencies that sit in the packed package's own
 * `node_modules`, and a workspace's dependencies are links to `packages/` it
 * does not follow: packing the workspace alone would ship a tarball whose
 * `@ldap-rest/*` imports resolve to nothing. Stage the package with real
 * copies of what it ships, then pack there.
 *
 * Usage: node scripts/pack-umbrella.mjs [--destination <dir>]
 *
 * See docs/development/packages.md.
 */
import { execFileSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { packages } from './packages.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const umbrellaDir = path.join(root, 'packages', 'ldap-rest');
const staging = path.join(root, 'temp', 'pack', 'ldap-rest');

const argument = name => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (index !== -1 && !value) throw new Error(`${name} needs a directory`);
  return value;
};

const manifest = JSON.parse(
  readFileSync(path.join(umbrellaDir, 'package.json'), 'utf8')
);

/**
 * What `files` publishes: the built package, and the documentation and
 * examples that stay at the repository root.
 */
const SHIPPED = [
  ['package.json', umbrellaDir],
  ['dist', umbrellaDir],
  ['bin', umbrellaDir],
  ['static', umbrellaDir],
  ['docs', root],
  ['examples', root],
  ['LICENSE', root],
];

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const [entry, from] of SHIPPED) {
  const source = path.join(from, entry);
  if (!existsSync(source)) {
    if (from === umbrellaDir)
      throw new Error(
        `pack-umbrella: ${entry} is missing, run the build first`
      );
    continue;
  }
  cpSync(source, path.join(staging, entry), { recursive: true });
}

const byName = new Map(packages().map(pkg => [pkg.name, pkg]));
for (const name of manifest.bundledDependencies ?? []) {
  const pkg = byName.get(name);
  if (!pkg)
    throw new Error(`pack-umbrella: ${name} is not a workspace package`);
  const source = path.join(root, pkg.dir);
  const dest = path.join(staging, 'node_modules', name);
  mkdirSync(path.dirname(dest), { recursive: true });
  for (const entry of manifestEntries(pkg.manifest)) {
    const from = path.join(source, entry);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(dest, entry), { recursive: true });
  }
}

/**
 * The files a package publishes: its manifest, which npm always includes, and
 * the `files` list, or everything for a package that has none.
 */
function manifestEntries(pkg) {
  const entries = pkg.files ?? ['.'];
  return ['package.json', ...entries.filter(entry => !entry.startsWith('!'))];
}

const destination = argument('--destination');
execFileSync(
  'npm',
  [
    'pack',
    ...(destination ? ['--pack-destination', path.resolve(destination)] : []),
  ],
  { cwd: staging, stdio: ['ignore', 'ignore', 'inherit'] }
);

const tarball = `ldap-rest-${manifest.version}.tgz`;
const produced = destination
  ? path.join(path.resolve(destination), tarball)
  : path.join(staging, tarball);
for (const file of [produced, path.join(staging, tarball)]) {
  if (existsSync(file) && statSync(file).size > 0) {
    console.log(file);
    process.exit(0);
  }
}
throw new Error(`pack-umbrella: npm produced no ${tarball}`);
