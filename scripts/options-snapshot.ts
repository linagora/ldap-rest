#!/usr/bin/env tsx
/**
 * Snapshot of the options the server reads, and the comparison the contracts
 * gate uses.
 *
 * See docs/development/contracts.md.
 *
 * Usage: npm run snapshot:options, or `--check` to fail when it is stale.
 */
import { readFileSync, realpathSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { ConfigEntry } from '../src/lib/parseConfig';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SNAPSHOT_PATH = path.join(
  root,
  'docs',
  'usage',
  'options.snapshot.json'
);

export interface OptionSnapshot {
  cli: string;
  aliases?: string[];
  plural?: string;
  env?: string;
  envAliases?: string[];
  type: string;
  default: unknown;
  kind?: string;
  required?: boolean;
}

export interface ContractDifference {
  kind: 'added' | 'removed' | 'changed';
  what: string;
  detail?: string;
}

/** Repository paths in a default depend on where the code sits: name them */
function normalizeValue(value: unknown, repository: string): unknown {
  if (typeof value === 'string')
    return value.startsWith(`${repository}/`)
      ? `<repo>${value.slice(repository.length)}`
      : value;
  if (Array.isArray(value))
    return value.map(item => normalizeValue(item, repository));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item, repository)])
    );
  return value;
}

/** The options `configArgs` declares, sorted by CLI name */
export function buildOptionsSnapshot(
  config: ConfigEntry[],
  repository: string = root
): OptionSnapshot[] {
  return config
    .map(entry => {
      const option: OptionSnapshot = {
        cli: entry[0],
        type: entry[3] ?? 'string',
        default: normalizeValue(entry[2], repository),
      };
      const aliases = entry[7]?.filter(Boolean);
      const plural = entry[4] ?? undefined;
      const kind = entry[5] ?? undefined;
      const env = entry[1] || undefined;
      const envAliases = entry[8]?.filter(Boolean);
      if (aliases?.length) option.aliases = [...aliases].sort();
      if (plural) option.plural = plural;
      if (env) option.env = env;
      if (envAliases?.length) option.envAliases = [...envAliases].sort();
      if (kind) option.kind = kind;
      if (entry[6]) option.required = true;
      return option;
    })
    .sort((left, right) => left.cli.localeCompare(right.cli));
}

export function serializeOptionsSnapshot(snapshot: OptionSnapshot[]): string {
  return JSON.stringify(snapshot, null, 2) + '\n';
}

/** Compare one field as JSON, so an object or an array reads the same way */
function field(option: OptionSnapshot, name: keyof OptionSnapshot): string {
  return JSON.stringify(option[name] ?? null);
}

/** What an option keeps of a version that had another CLI name */
function renamedFields(
  base: OptionSnapshot,
  now: OptionSnapshot
): ContractDifference[] {
  const differences: ContractDifference[] = [];
  for (const name of [
    'plural',
    'type',
    'default',
    'kind',
    'required',
  ] as const) {
    if (field(base, name) !== field(now, name))
      differences.push({
        kind: 'changed',
        what: `option ${now.cli}`,
        detail: `${name}: ${field(base, name)} → ${field(now, name)}`,
      });
  }
  if (!envKept(base, now))
    differences.push({
      kind: 'changed',
      what: `option ${now.cli}`,
      detail: `env: ${field(base, 'env')} → ${field(now, 'env')} without an alias`,
    });
  return differences;
}

/** Whether the base version's environment variable is still read */
function envKept(base: OptionSnapshot, now: OptionSnapshot): boolean {
  if (!base.env || now.env === base.env) return true;
  return (now.envAliases ?? []).includes(base.env);
}

/**
 * What a pull request changes in the options contract. An added option is
 * additive; a removed or changed one is not. A renamed option whose old CLI
 * name and environment variable stay as aliases is a deprecation, not a
 * removal.
 */
export function diffOptionsSnapshot(
  base: OptionSnapshot[],
  current: OptionSnapshot[]
): ContractDifference[] {
  const before = new Map(base.map(option => [option.cli, option]));
  const after = new Map(current.map(option => [option.cli, option]));
  const aliased = new Map<string, OptionSnapshot>();
  for (const option of current)
    for (const alias of option.aliases ?? []) aliased.set(alias, option);
  const differences: ContractDifference[] = [];

  for (const [cli, option] of before) {
    const direct = after.get(cli);
    const now = direct ?? aliased.get(cli);
    if (!now) {
      differences.push({ kind: 'removed', what: `option ${cli}` });
      continue;
    }
    if (!direct) {
      differences.push(...renamedFields(option, now));
      continue;
    }
    // A name kept as an alias is additive; dropping one breaks its users
    for (const name of ['aliases', 'envAliases'] as const) {
      const kept = now[name] ?? [];
      for (const alias of option[name] ?? [])
        if (!kept.includes(alias))
          differences.push({
            kind: 'changed',
            what: `option ${cli}`,
            detail: `${name}: ${alias} removed`,
          });
    }
    for (const name of [
      'plural',
      'type',
      'default',
      'kind',
      'required',
    ] as const) {
      if (field(option, name) !== field(now, name))
        differences.push({
          kind: 'changed',
          what: `option ${cli}`,
          detail: `${name}: ${field(option, name)} → ${field(now, name)}`,
        });
    }
    if (!envKept(option, now))
      differences.push({
        kind: 'changed',
        what: `option ${cli}`,
        detail: `env: ${field(option, 'env')} → ${field(now, 'env')} without an alias`,
      });
  }
  for (const [cli, option] of after)
    if (!before.has(cli))
      differences.push({
        kind: 'added',
        what: `option ${cli}`,
        detail: option.env,
      });

  return differences;
}

/** Removed or changed entries break a published contract; added ones do not */
export function nonAdditive(
  differences: ContractDifference[]
): ContractDifference[] {
  return differences.filter(difference => difference.kind !== 'added');
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  // Imported here rather than at module load so the tests and the contracts
  // comparison can import this module without pulling every plugin option in
  const { default: configArgs } = (await import('../src/config/args')) as {
    default: ConfigEntry[];
  };
  const generated = serializeOptionsSnapshot(buildOptionsSnapshot(configArgs));

  if (!check) {
    writeFileSync(SNAPSHOT_PATH, generated);
    console.log(`Wrote ${path.relative(root, SNAPSHOT_PATH)}`);
    return;
  }

  let committed: string;
  try {
    committed = readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch {
    console.error(
      `${path.relative(root, SNAPSHOT_PATH)} is missing: run ` +
        '`npm run snapshot:options`.'
    );
    process.exitCode = 1;
    return;
  }
  if (generated === committed) {
    console.log('options.snapshot.json is up to date');
    return;
  }

  const differences = diffOptionsSnapshot(
    JSON.parse(committed) as OptionSnapshot[],
    JSON.parse(generated) as OptionSnapshot[]
  );
  console.error(
    'options.snapshot.json is stale: run `npm run snapshot:options` and ' +
      'commit it.'
  );
  if (differences.length === 0)
    console.error(
      '  The options are the same; the committed file differs in ordering or formatting.'
    );
  for (const difference of differences)
    console.error(
      `  ${difference.kind} ${difference.what}${difference.detail ? ` (${difference.detail})` : ''}`
    );
  process.exitCode = 1;
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
