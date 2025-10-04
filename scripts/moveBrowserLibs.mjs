#!/usr/bin/env node
/**
 * Post-build script to move browser libraries from dist/ to static/
 * while keeping types in dist/
 */

import { mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';

const srcDir = 'dist/browser';
const destDir = 'static/browser';

function moveJsFiles(src, dest) {
  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src);

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      // Recursively move JS files from subdirectories
      moveJsFiles(srcPath, destPath);
    } else if (entry.endsWith('.js') || entry.endsWith('.js.map')) {
      // Move JS and source map files
      console.log(`Moving ${srcPath} → ${destPath}`);
      renameSync(srcPath, destPath);
    }
    // Skip .d.ts files - they stay in dist/
  }
}

try {
  moveJsFiles(srcDir, destDir);
  console.log('✓ Browser libraries moved to static/browser/');
} catch (error) {
  console.error('Error moving browser libraries:', error);
  process.exit(1);
}
