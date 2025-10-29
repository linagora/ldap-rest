#!/usr/bin/env node
/**
 * Post-build script to move browser libraries from dist/ to static/
 * while keeping types in dist/
 */

import { mkdirSync, readdirSync, renameSync, statSync, copyFileSync } from 'fs';
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

function copySharedCss() {
  const srcCss = 'src/browser/shared/styles/common-demo.css';
  const destCss = 'static/browser/common-demo.css';

  try {
    console.log(`Copying ${srcCss} → ${destCss}`);
    copyFileSync(srcCss, destCss);
    console.log('✓ Shared CSS copied to static/browser/');
  } catch (error) {
    console.error('Error copying shared CSS:', error);
  }
}

function copyExamples() {
  const srcDir = 'examples/web';
  const destDir = 'static/examples/web';

  try {
    mkdirSync(destDir, { recursive: true });

    const files = readdirSync(srcDir);
    for (const file of files) {
      if (file.endsWith('.html')) {
        const srcPath = join(srcDir, file);
        const destPath = join(destDir, file);
        console.log(`Copying ${srcPath} → ${destPath}`);
        copyFileSync(srcPath, destPath);
      }
    }
    console.log('✓ HTML examples copied to static/examples/web/');
  } catch (error) {
    console.error('Error copying examples:', error);
  }
}

try {
  moveJsFiles(srcDir, destDir);
  console.log('✓ Browser libraries moved to static/browser/');

  copySharedCss();
  copyExamples();
} catch (error) {
  console.error('Error moving browser libraries:', error);
  process.exit(1);
}
