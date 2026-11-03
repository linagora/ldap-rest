/* eslint-disable no-undef */
import { builtinModules } from 'module';
import { readFileSync } from 'fs';

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import { glob } from 'tinyglobby';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const externalPackages = Object.keys({
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
  ...(pkg.peerDependencies ?? {}),
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
