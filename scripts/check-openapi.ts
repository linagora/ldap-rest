#!/usr/bin/env tsx
/**
 * Fail when the committed OpenAPI document differs from what the plugins
 * declare: `openapi.json` is published, so it must follow the code.
 *
 * See docs/plugin-development/openapi.md.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { OpenAPIGenerator } from './generate-openapi';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const document = path.join(root, 'openapi.json');

const main = async (): Promise<void> => {
  const generator = new OpenAPIGenerator(root);
  await generator.analyze();
  const generated = JSON.stringify(generator.generateSpec(), null, 2);

  let committed = '';
  try {
    committed = readFileSync(document, 'utf8');
  } catch {
    console.error('openapi.json is missing: run `npm run generate:openapi`.');
    process.exitCode = 1;
    return;
  }

  if (generated === committed) {
    console.log('openapi.json is up to date');
    return;
  }

  console.error(
    'openapi.json is stale: run `npm run generate:openapi` and commit it.'
  );
  const before = committed.split('\n');
  const after = generated.split('\n');
  const at = before.findIndex((line, index) => line !== after[index]);
  console.error(`first difference at line ${at + 1}:`);
  console.error(`  committed: ${before[at] ?? '(end of file)'}`);
  console.error(`  generated: ${after[at] ?? '(end of file)'}`);
  process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
