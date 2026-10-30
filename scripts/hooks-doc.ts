#!/usr/bin/env tsx
/**
 * Check `docs/plugin-development/hooks.md` against `src/hooks.ts`: every
 * hook the interface names is documented, and the document names nothing
 * else.
 *
 *   npm run check:hooks              fails, naming what differs
 *   npm run check:hooks -- --write   drops the entries of hooks no longer
 *                                    declared, if any
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(root, 'src', 'hooks.ts');
const DOC = path.join(root, 'docs', 'plugin-development', 'hooks.md');

const BEGIN =
  '<!-- hooks: generated from src/hooks.ts, do not edit by hand -->';
const END = '<!-- /hooks -->';

/** The hooks `Hooks` declares, in the order it declares them */
export function declaredHooks(source: string): string[] {
  const start = source.indexOf('export interface Hooks {');
  if (start < 0) throw new Error('src/hooks.ts declares no Hooks interface');
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = source.slice(start, end);
  const names = [...body.matchAll(/^\s{2}([\w_]+)\??:/gm)].map(
    (match): string => match[1]!
  );
  return [...new Set(names)];
}

/**
 * The hook an entry of the list documents.
 *
 * @param line the entry
 * @returns its name, or undefined for anything else in the block
 */
function entryName(line: string): string | undefined {
  // Prettier escapes the underscore a name may start with
  return /^- \*\*\\?([\w_]+)\*\*/.exec(line)?.[1];
}

/**
 * The block of the document that lists the hooks.
 *
 * @param doc the document
 * @returns the block's text, markers aside, and what stands around it
 */
export function block(doc: string): {
  before: string;
  list: string[];
  after: string;
} {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0)
    throw new Error(
      `docs/plugin-development/hooks.md has no ${BEGIN} … ${END} block`
    );
  return {
    before: doc.slice(0, start + BEGIN.length),
    list: doc
      .slice(start + BEGIN.length, end)
      .split('\n')
      .filter(line => line.trim()),
    after: doc.slice(end),
  };
}

/**
 * What differs between the hooks declared and the ones the document lists.
 *
 * @param source `src/hooks.ts`
 * @param doc the document
 * @returns the missing and the unknown names, each sorted
 */
export function differences(
  source: string,
  doc: string
): { missing: string[]; unknown: string[] } {
  const declared = declaredHooks(source);
  const listed = block(doc)
    .list.map(entryName)
    .filter((name): name is string => Boolean(name));
  return {
    missing: declared.filter(name => !listed.includes(name)),
    unknown: listed.filter(name => !declared.includes(name)),
  };
}

/**
 * The document with the entries of hooks it no longer declares dropped.
 *
 * @param source `src/hooks.ts`
 * @param doc the document
 * @returns the document, every other entry kept where it was
 */
export function withoutCompiledAway(source: string, doc: string): string {
  const { before, list, after } = block(doc);
  const declared = declaredHooks(source);
  const known = list.filter(line => {
    const name = entryName(line);
    return name !== undefined && declared.includes(name);
  });
  return [before, ...known, '', after].join('\n');
}

function main(): void {
  const source = fs.readFileSync(HOOKS, 'utf8');
  const doc = fs.readFileSync(DOC, 'utf8');
  if (process.argv.includes('--write')) {
    fs.writeFileSync(DOC, withoutCompiledAway(source, doc));
    return;
  }
  const { missing, unknown } = differences(source, doc);
  if (missing.length === 0 && unknown.length === 0) return;
  if (missing.length > 0)
    console.error(`Not documented: ${missing.join(', ')}`);
  if (unknown.length > 0)
    console.error(`Not declared in src/hooks.ts: ${unknown.join(', ')}`);
  process.exitCode = 1;
}

if (process.argv[1] && /hooks-doc\.ts$/.test(process.argv[1])) main();
