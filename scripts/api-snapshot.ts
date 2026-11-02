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
  readFileSync,
  realpathSync,
  rmSync,
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
 * The entry points of `.`, `./hooks`, `./plugin`, `./ldapactions` and
 * `./expressformatedresponses`, as `rollup.config.mjs` generates them.
 */
export const API_ENTRIES: Record<string, string> = {
  'ldap-rest': 'src/bin/index.d.ts',
  expressformatedresponses: 'src/lib/expressFormatedResponses.d.ts',
  hooks: 'src/hooks.d.ts',
  ldapactions: 'src/lib/ldapActions.d.ts',
  plugin: 'src/abstract/plugin.d.ts',
};

export function reportPath(name: string): string {
  return path.join(API_REPORT_DIR, `${name}.api.md`);
}

/** TSDoc, forgotten exports and a fresh report folder leave the types alone */
function ignoreNoise(message: ExtractorMessage): void {
  if (
    message.messageId.startsWith('tsdoc-') ||
    message.messageId === 'ae-forgotten-export' ||
    message.messageId === 'ae-missing-release-tag' ||
    message.messageId === 'api-extractor-missing-file'
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
  const end = lines.findIndex(
    (line, index) => index > fence && line.startsWith('```')
  );
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const block = current.join('\n').trimEnd();
    found.set(declarationName(block), block);
    current = [];
  };
  for (const line of lines.slice(fence + 1, end === -1 ? undefined : end)) {
    // A release tag or a re-export line opens the next declaration
    if (line.startsWith('// @') || line.startsWith('export {')) flush();
    current.push(line);
  }
  flush();
  return found;
}

export function diffApiReports(
  base: string,
  current: string
): ApiReportChanges {
  const before = declarationsIn(base);
  const after = declarationsIn(current);
  return {
    removed: [...before.keys()].filter(name => !after.has(name)),
    added: [...after.keys()].filter(name => !before.has(name)),
    changed: [...before.keys()].filter(
      name => after.has(name) && after.get(name) !== before.get(name)
    ),
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
  for (const [name, entryPoint] of Object.entries(API_ENTRIES))
    extract(name, entryPoint, folder);
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
