#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * Publish every workspace package, dependencies first.
 *
 * The umbrella is left out: it is published from its own tarball, after the
 * packages, which that tarball bundles.
 *
 * Usage: node scripts/publish-packages.mjs [--tag <dist-tag>] [--dry-run]
 *
 * See docs/development/packages.md.
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { packages } from './packages.mjs';

/** The package names to publish, in the order they must appear */
export function publishOrder() {
  return packages()
    .map(pkg => pkg.name)
    .filter(name => name !== 'ldap-rest');
}

const argument = name => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} needs a value`);
  return value;
};

/** Whether that exact version is already in the registry */
function published(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tag = argument('--tag');
  const byName = new Map(packages().map(pkg => [pkg.name, pkg.manifest]));
  for (const name of publishOrder()) {
    const manifest = byName.get(name);
    if (dryRun) {
      console.log(`would publish ${name}@${manifest.version}`);
      continue;
    }
    if (published(name, manifest.version)) {
      console.log(`${name}@${manifest.version} is already published`);
      continue;
    }
    console.log(`publishing ${name}@${manifest.version}`);
    execFileSync(
      'npm',
      [
        'publish',
        '--workspace',
        name,
        '--access',
        'public',
        ...(tag ? ['--tag', tag] : []),
      ],
      { stdio: 'inherit' }
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
