#!/usr/bin/env node
/**
 * Compose what the umbrella serves and publishes from the packages that own
 * it: the `static` tree (schemas and browser libraries) and the browser
 * declarations the `./browser-*` entries point at.
 *
 * The build runs this before bundling the umbrella, because `package.json`
 * exports are generated from the package sources. See
 * docs/development/packages.md.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';

/** Copy `src` into `dest`, keeping only the files `accept` takes */
const copyTree = (src, dest, accept = () => true) => {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    if (statSync(from).isDirectory()) copyTree(from, to, accept);
    else if (accept(from)) copyFileSync(from, to);
  }
};

for (const [from, dest] of [
  ['packages/schemas/static/schemas', 'static/schemas'],
  ['packages/browser/static/browser', 'static/browser'],
]) {
  rmSync(dest, { recursive: true, force: true });
  copyTree(from, dest);
}

if (existsSync('packages/browser/dist')) {
  rmSync('dist/src/browser', { recursive: true, force: true });
  copyTree('packages/browser/dist', 'dist/src/browser', file =>
    file.endsWith('.d.ts')
  );
}
