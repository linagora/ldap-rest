#!/usr/bin/env tsx
/**
 * The TypeScript types each sub-path export publishes, extracted by
 * @microsoft/api-extractor into etc/api/.
 *
 * See docs/development/contracts.md.
 *
 * Usage: npm run snapshot:api, or `--check` to fail when it is stale.
 */
import { execFileSync } from 'child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import type { ExtractorMessage, IConfigFile } from '@microsoft/api-extractor';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const API_REPORT_DIR = path.join(root, 'etc', 'api');

const declarations = path.join(root, 'temp', 'api', 'declarations');
const reportTempDir = path.join(root, 'temp', 'api', 'reports');

/**
 * The entry points of `.`, `./hooks`, `./plugin`, `./ldapactions`,
 * `./expressformatedresponses` and every `./plugin-*`, as
 * `rollup.config.mjs` generates them. The plugin entries are read from
 * `package.json`, so a new plugin is reported without another list to update.
 */
const packageJson = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8')
) as { exports?: Record<string, { types?: string }> };

const pluginEntries: Record<string, string> = Object.fromEntries(
  Object.entries(packageJson.exports ?? {})
    .filter(
      ([subpath, entry]) =>
        subpath.startsWith('./plugin-') && typeof entry.types === 'string'
    )
    .map(([subpath, entry]) => [
      subpath.slice(2).replace(/\//g, '-'),
      entry.types!.replace(/^\.\/dist\//, ''),
    ])
);

export const API_ENTRIES: Record<string, string> = {
  'ldap-rest': 'packages/core/src/bin/index.d.ts',
  expressformatedresponses:
    'packages/core/src/lib/expressFormatedResponses.d.ts',
  hooks: 'packages/core/src/hooks.d.ts',
  ldapactions: 'packages/core/src/lib/ldapActions.d.ts',
  plugin: 'packages/core/src/abstract/plugin.d.ts',
  ...pluginEntries,
};

const CORE_ENTRIES = new Set([
  'ldap-rest',
  'expressformatedresponses',
  'hooks',
  'ldapactions',
  'plugin',
]);

export function reportPath(name: string): string {
  return path.join(API_REPORT_DIR, `${name}.api.md`);
}

/**
 * TSDoc, release tags and a fresh report folder leave the types alone. A
 * forgotten export is reported in the report itself, so its shape is pinned.
 */
function ignoreNoise(message: ExtractorMessage): void {
  if (
    message.messageId.startsWith('tsdoc-') ||
    message.messageId === 'ae-forgotten-export' ||
    message.messageId === 'ae-missing-release-tag' ||
    message.messageId === 'api-extractor-missing-file' ||
    // The stripped plugin report differs from its full seed, and a new
    // plugin report is expected to be created; the stale check compares the
    // stripped files themselves.
    message.messageId === 'console-api-report-copied' ||
    message.messageId === 'console-api-report-created'
  )
    message.handled = true;
}

function emitDeclarations(): void {
  rmSync(declarations, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.api.json'],
    { cwd: root, stdio: 'inherit' }
  );
}

function extract(name: string, entryPoint: string, folder: string): void {
  mkdirSync(folder, { recursive: true });
  const configObject: IConfigFile = {
    projectFolder: root,
    mainEntryPointFilePath: path.join(declarations, entryPoint),
    apiReport: {
      enabled: true,
      reportFileName: `${name}.api.md`,
      reportFolder: folder,
      reportTempFolder: reportTempDir,
      includeForgottenExports: true,
    },
    newlineKind: 'lf',
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    compiler: { tsconfigFilePath: path.join(root, 'tsconfig.api.json') },
  };
  const config = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: path.join(root, 'api-extractor.json'),
    packageJsonFullPath: path.join(root, 'package.json'),
  });
  const result = Extractor.invoke(config, {
    localBuild: true,
    showVerboseMessages: false,
    messageCallback: ignoreNoise,
  });
  if (!result.succeeded)
    throw new Error(
      `api-extractor failed on ${name}: ${result.errorCount} error(s)`
    );
}

/**
 * Drop from a plugin report the declaration blocks identical to one in a
 * core report: an inlined `Config` or `DM` is already gated there, and
 * repeating it makes every core option change rewrite every plugin report.
 */
export function stripCoreDeclarations(
  report: string,
  core: Set<string>
): string {
  const lines = report.split('\n');
  const fence = lines.findIndex(line => line.startsWith('```'));
  const start = lines.findIndex(line => line.startsWith('// @'));
  const end = lines.findIndex(
    (line, index) => index > fence && line.startsWith('```')
  );
  if (start === -1) return report;
  const out = lines.slice(0, start);
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const block = current.join('\n').trimEnd();
    if (!core.has(block)) out.push(...current);
    current = [];
  };
  for (const line of lines.slice(start, end === -1 ? undefined : end)) {
    if (
      line.startsWith('// @') ||
      line.startsWith('export {') ||
      line.startsWith('declare namespace ')
    )
      flush();
    current.push(line);
  }
  flush();
  if (end !== -1) out.push(...lines.slice(end));
  return out.join('\n');
}

export interface ApiReportChanges {
  removed: string[];
  added: string[];
  changed: string[];
}

/** A declaration's name, or its whole line when it has none to read */
function declarationName(block: string): string {
  const named =
    /^(?:export )?(?:declare )?(?:abstract )?(?:class|interface|type|function|const|enum|namespace|let|var) ([A-Za-z0-9_$]+)/m.exec(
      block
    );
  if (named?.[1]) return named[1];
  const line = block
    .split('\n')
    .find(line => line.trim() && !line.startsWith('//'));
  return line?.trim() ?? block.trim();
}

function declarationsIn(report: string): Map<string, string> {
  const found = new Map<string, string>();
  const lines = report.split('\n');
  const fence = lines.findIndex(line => line.startsWith('```'));
  // The import header names the dependencies, not the declarations: the first
  // release tag opens the report
  const start = lines.findIndex(line => line.startsWith('// @'));
  const end = lines.findIndex(
    (line, index) => index > fence && line.startsWith('```')
  );
  if (start === -1) return found;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const block = current.join('\n').trimEnd();
    const name = declarationName(block);
    // Overloads and merged declarations share a name; keep them apart
    let key = name;
    for (let rank = 2; found.has(key); rank++) key = `${name} #${rank}`;
    found.set(key, block);
    current = [];
  };
  for (const line of lines.slice(start, end === -1 ? undefined : end)) {
    // A release tag, a re-export line or a namespace without one of its own
    // opens the next declaration
    if (
      line.startsWith('// @') ||
      line.startsWith('export {') ||
      line.startsWith('declare namespace ')
    )
      flush();
    current.push(line);
  }
  flush();
  return found;
}

/** The declaration line of a block, release tag and blank lines aside */
function declarationLine(block: string): string {
  return (
    block
      .split('\n')
      .find(line => line.trim() && !line.startsWith('//'))
      ?.trim() ?? ''
  );
}

/**
 * The names a plugin can write: the exported declarations, the names the
 * report re-exports, and the members of an exported namespace. A type only
 * reachable through a signature is not one of them.
 */
function nameableIn(report: string): Set<string> {
  const names = new Set<string>();
  for (const [, exported] of report.matchAll(/^export \{ ([^}]+) \}$/gm))
    for (const name of exported.split(',')) names.add(name.trim());
  for (const [, members] of report.matchAll(
    /declare namespace [A-Za-z0-9_$]+ \{\s*export \{([^}]*)\}/g
  ))
    for (const name of members.split(',')) names.add(name.trim());
  return names;
}

export function diffApiReports(
  base: string,
  current: string
): ApiReportChanges {
  const before = declarationsIn(base);
  const after = declarationsIn(current);
  const nameable = nameableIn(base);
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, block] of before) {
    if (!after.has(name)) {
      // A rename of a type nobody can name breaks nothing: the declarations
      // that use it show up as changed
      const exported =
        declarationLine(block).startsWith('export') ||
        nameable.has(name.replace(/ #\d+$/, ''));
      (exported ? removed : changed).push(name);
      continue;
    }
    if (after.get(name) !== block) changed.push(name);
  }
  return {
    removed,
    added: [...after.keys()].filter(name => !before.has(name)),
    changed,
  };
}

/**
 * Seed `folder` with the reports already in `seed`, so API Extractor compares
 * the declarations with them and announces only what changed.
 */
export async function buildApiReports(
  folder: string,
  seed = folder
): Promise<void> {
  rmSync(reportTempDir, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  if (seed !== folder)
    for (const name of Object.keys(API_ENTRIES))
      if (existsSync(path.join(seed, `${name}.api.md`)))
        copyFileSync(
          path.join(seed, `${name}.api.md`),
          path.join(folder, `${name}.api.md`)
        );
  emitDeclarations();
  const coreBlocks = new Set<string>();
  for (const [name, entryPoint] of Object.entries(API_ENTRIES)) {
    extract(name, entryPoint, folder);
    const file = path.join(folder, `${name}.api.md`);
    const report = readFileSync(file, 'utf8');
    if (CORE_ENTRIES.has(name))
      for (const block of declarationsIn(report).values())
        coreBlocks.add(block);
    else writeFileSync(file, stripCoreDeclarations(report, coreBlocks));
  }
}

function stale(name: string, folder: string): boolean {
  const generated = readFileSync(path.join(folder, `${name}.api.md`), 'utf8');
  let committed: string;
  try {
    committed = readFileSync(reportPath(name), 'utf8');
  } catch {
    console.error(
      `${path.relative(root, reportPath(name))} is missing: run ` +
        '`npm run snapshot:api` and commit it.'
    );
    return true;
  }
  if (generated === committed) return false;
  console.error(
    `${path.relative(root, reportPath(name))} is stale: run ` +
      '`npm run snapshot:api` and commit it.'
  );
  const before = committed.split('\n');
  const after = generated.split('\n');
  const difference = before.findIndex((line, index) => line !== after[index]);
  const at = difference === -1 ? before.length : difference;
  console.error(`  first difference at line ${at + 1}:`);
  console.error(`    committed: ${before[at] ?? '(end of file)'}`);
  console.error(`    generated: ${after[at] ?? '(end of file)'}`);
  return true;
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const folder = path.join(root, 'temp', 'api', 'check');
    await buildApiReports(folder, API_REPORT_DIR);
    const outdated = Object.keys(API_ENTRIES).filter(name =>
      stale(name, folder)
    );
    const produced = new Set(
      Object.keys(API_ENTRIES).map(name => `${name}.api.md`)
    );
    for (const file of readdirSync(API_REPORT_DIR))
      if (file.endsWith('.api.md') && !produced.has(file)) {
        console.error(
          `${path.relative(root, reportPath(file.replace(/\.api\.md$/, '')))} ` +
            'has no entry: remove it, or list it in package.json exports.'
        );
        outdated.push(file);
      }
    if (outdated.length === 0)
      console.log('every API report in etc/api/ is up to date');
    else process.exitCode = 1;
    return;
  }
  await buildApiReports(API_REPORT_DIR);
  console.log(
    `wrote ${Object.keys(API_ENTRIES).length} API reports to ` +
      `${path.relative(root, API_REPORT_DIR)}/`
  );
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

if (isMain())
  main().catch((error: unknown) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
