/* eslint-disable no-undef */
import { builtinModules } from 'module';
import { copyFileSync, mkdirSync, readFileSync } from 'fs';

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import { glob } from 'tinyglobby';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const externalPackages = Object.keys({
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
});

const external = id => {
  const bare = id.replace(/^node:/, '');
  if (
    builtinModules.includes(bare) ||
    builtinModules.includes(bare.split('/')[0])
  )
    return true;
  return externalPackages.some(dep => id === dep || id.startsWith(`${dep}/`));
};

export default async () => ({
  input: await glob('src/**/*.ts', { ignore: ['**/*.d.ts'] }),
  output: {
    dir: 'dist',
    format: 'es',
    preserveModules: true,
    preserveModulesRoot: 'src',
    sourcemap: process.env.NODE_ENV !== 'production',
  },
  plugins: [
    {
      // `priority.json` is read as data, and the core package exports it at
      // its historical path: keep a copy beside the module Rollup emits.
      name: 'copy-priority',
      writeBundle() {
        mkdirSync('dist/config', { recursive: true });
        copyFileSync('src/config/priority.json', 'dist/config/priority.json');
      },
    },
    commonjs(),
    json(),
    typescript({
      tsconfig: './tsconfig.json',
      module: 'ESNext',
      rootDir: 'src',
      include: ['**/*.ts'],
      outDir: 'dist',
      declaration: true,
      declarationDir: 'dist',
      declarationMap: false,
      sourceMap: process.env.NODE_ENV !== 'production',
    }),
  ],
  external,
});
