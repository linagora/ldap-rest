#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * The workspace packages under `packages/`, and what the umbrella needs to
 * know about them.
 *
 * Usage:
 *   node scripts/packages.mjs list           package directories, dependencies first
 *   node scripts/packages.mjs build          build every package, dependencies first
 *   node scripts/packages.mjs build --stale  build only the packages whose inputs changed
 *   node scripts/packages.mjs sync           write the TypeScript paths and the coverage
 *                                            roots of every package
 *   node scripts/packages.mjs check          fail when those or the umbrella's
 *                                            dependencies miss a package
 *
 * See docs/development/packages.md.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files outside a package whose change rebuilds every package */
const SHARED_INPUTS = ['scripts/rollup.package.mjs', 'tsconfig.base.json'];

const readJson = file =>
  JSON.parse(readFileSync(path.join(root, file), 'utf8'));

/** Every package, dependencies before their dependents */
export function packages() {
  const found = readdirSync(path.join(root, 'packages'), {
    withFileTypes: true,
  })
    .filter(
      entry =>
        entry.isDirectory() &&
        existsSync(path.join(root, 'packages', entry.name, 'package.json'))
    )
    .map(entry => {
      const dir = `packages/${entry.name}`;
      const manifest = readJson(`${dir}/package.json`);
      return { dir, name: manifest.name, manifest };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const byName = new Map(found.map(pkg => [pkg.name, pkg]));
  const ordered = [];
  const state = new Map();
  const visit = (pkg, chain) => {
    if (state.get(pkg.name) === 'done') return;
    if (state.get(pkg.name) === 'visiting')
      throw new Error(
        `packages: dependency cycle ${[...chain, pkg.name].join(' -> ')}`
      );
    state.set(pkg.name, 'visiting');
    const { dependencies, peerDependencies, optionalDependencies } =
      pkg.manifest;
    for (const dep of Object.keys({
      ...dependencies,
      ...peerDependencies,
      ...optionalDependencies,
    }).sort()) {
      const target = byName.get(dep);
      if (target) visit(target, [...chain, pkg.name]);
    }
    state.set(pkg.name, 'done');
    ordered.push(pkg);
  };
  for (const pkg of found) visit(pkg, []);
  return ordered;
}

/**
 * Every file under `dir`, recursively, and with `withDirs` the directories
 * too, `dir` included; none when it does not exist.
 */
function entriesUnder(dir, withDirs = false) {
  if (!existsSync(dir)) return [];
  return [
    ...(withDirs ? [dir] : []),
    ...readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() || (withDirs && entry.isDirectory()))
      .map(entry => path.join(entry.parentPath, entry.name)),
  ];
}

/**
 * Whether a package's dist is older than one of its inputs. The source
 * directories count: removing or renaming a file changes their time only.
 */
function stale(pkg) {
  const dist = entriesUnder(path.join(root, pkg.dir, 'dist'));
  if (dist.length === 0) return true;
  const built = Math.min(...dist.map(file => statSync(file).mtimeMs));
  const inputs = [
    ...entriesUnder(path.join(root, pkg.dir, 'src'), true),
    ...['package.json', 'rollup.config.mjs', 'tsconfig.json'].map(file =>
      path.join(root, pkg.dir, file)
    ),
    ...SHARED_INPUTS.map(file => path.join(root, file)),
  ].filter(file => existsSync(file));
  return inputs.some(file => statSync(file).mtimeMs > built);
}

function build(onlyStale) {
  const rollup = path.join(root, 'node_modules', '.bin', 'rollup');
  const rebuilt = new Set();
  for (const pkg of packages()) {
    const deps = Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.peerDependencies,
      ...pkg.manifest.optionalDependencies,
    });
    if (onlyStale && !stale(pkg) && !deps.some(dep => rebuilt.has(dep)))
      continue;
    const dist = path.join(root, pkg.dir, 'dist');
    rmSync(dist, { recursive: true, force: true });
    console.log(`packages: building ${pkg.name}`);
    const run = spawnSync(rollup, ['-c'], {
      cwd: path.join(root, pkg.dir),
      stdio: 'inherit',
    });
    if (run.status !== 0) {
      // A partial dist would look fresh to the next `--stale` run
      rmSync(dist, { recursive: true, force: true });
      process.exit(run.status ?? 1);
    }
    rebuilt.add(pkg.name);
  }
}

/**
 * The TypeScript paths that resolve each package the way Node resolves it:
 * one entry per `exports` key, to the sources (`development`) for the
 * type-check and the tests, or to the built declarations (`types`) for the
 * API reports.
 */
function pathsOf(target) {
  const paths = {};
  for (const pkg of packages()) {
    for (const [key, conditions] of Object.entries(
      pkg.manifest.exports ?? {}
    )) {
      if (!conditions || typeof conditions !== 'object') continue;
      const file =
        target === 'sources'
          ? (conditions.development ?? conditions.default)
          : (conditions.types ?? conditions.default);
      if (!file) continue;
      const alias = key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
      paths[alias] = [`./${pkg.dir}/${file.slice(2)}`];
    }
  }
  return paths;
}

/**
 * The module names the umbrella serves, as `core/…` to the package the shim
 * of that name re-exports. A configuration may name either spelling; the
 * server reads this table to know that they designate the same plugin.
 */
function pluginModules() {
  const pluginRoot = path.join(root, 'src', 'plugins');
  const names = new Set(packages().map(pkg => pkg.name));
  const modules = {};
  for (const file of entriesUnder(pluginRoot)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(file, 'utf8');
    // A shim re-exports: it declares no class, no function and no constant
    const pkg = /from '@ldap-rest\/([a-z0-9-]+)(?:'|\/)/.exec(text)?.[1];
    if (!pkg || pkg === 'core' || !names.has(`@ldap-rest/${pkg}`)) continue;
    if (
      !/\bdefault\b/.test(text) ||
      /\b(class|function|const|let)\b/.test(text)
    )
      continue;
    const name = path
      .relative(pluginRoot, file)
      .replace(/\.ts$/, '')
      .split(path.sep)
      .join('/');
    modules[`core/${name}`] = `@ldap-rest/${pkg}`;
  }
  return Object.fromEntries(
    Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))
  );
}

/**
 * The configuration files that name every package, and what `sync` sets in
 * each. c8 takes its `src` entries as directories, not globs, so the coverage
 * roots are listed one per package like the TypeScript paths.
 */
const GENERATED = [
  {
    file: 'tsconfig.json',
    set: config => (config.compilerOptions.paths = pathsOf('sources')),
  },
  {
    file: 'tsconfig.api.json',
    set: config => (config.compilerOptions.paths = pathsOf('declarations')),
  },
  {
    file: '.c8rc.json',
    set: config =>
      (config.src = [
        'src',
        ...packages()
          .map(pkg => `${pkg.dir}/src`)
          .sort(),
      ]),
  },
  { file: 'src/pluginModules.json', build: pluginModules },
];

/** Each generated file as `sync` writes it, beside its current text */
async function generated() {
  const prettier = await import('prettier');
  return Promise.all(
    GENERATED.map(async ({ file, set, build }) => {
      const target = path.join(root, file);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const config = build ? build() : JSON.parse(current);
      if (set) set(config);
      const options = await prettier.resolveConfig(target);
      const wanted = await prettier.format(JSON.stringify(config), {
        ...options,
        filepath: target,
      });
      return { file, current, wanted };
    })
  );
}

async function sync() {
  for (const { file, current, wanted } of await generated()) {
    if (current === wanted) continue;
    await writeFile(path.join(root, file), wanted);
    console.log(`packages: wrote ${file}`);
  }
}

async function check() {
  const problems = [];
  for (const { file, current, wanted } of await generated())
    if (current !== wanted)
      problems.push(`${file} is stale: run npm run sync:packages`);

  // Until phase 3 publishes the packages, the umbrella ships them in its own
  // tarball: one it does not depend on and bundle is missing once installed.
  const umbrella = readJson('package.json');
  const bundled = new Set(umbrella.bundledDependencies ?? []);
  for (const pkg of packages()) {
    const version = umbrella.dependencies?.[pkg.name];
    if (version !== pkg.manifest.version)
      problems.push(
        `package.json: dependencies must hold "${pkg.name}": "${pkg.manifest.version}"` +
          (version ? `, not "${version}"` : '')
      );
    if (!bundled.has(pkg.name))
      problems.push(`package.json: bundledDependencies must list ${pkg.name}`);
  }

  if (problems.length) {
    for (const problem of problems) console.error(`packages: ${problem}`);
    process.exit(1);
  }
  console.log(`packages: ${packages().length} packages wired`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'list':
      for (const pkg of packages()) console.log(pkg.dir);
      break;
    case 'build':
      build(args.includes('--stale'));
      break;
    case 'sync':
      await sync();
      break;
    case 'check':
      await check();
      break;
    default:
      console.error(
        'usage: node scripts/packages.mjs list | build [--stale] | sync | check'
      );
      process.exit(2);
  }
}
