/* eslint-disable no-undef */
/**
 * The Rollup configuration every workspace package builds with, run from the
 * package's own directory: `src/` to `dist/`, one module per source, with
 * the package's declared dependencies (peers included) left external.
 *
 * A package's `rollup.config.mjs` is `export default packageConfig()`, with
 * extra Rollup plugins as the argument when it ships more than its modules.
 *
 * See docs/development/packages.md.
 */
import { builtinModules } from 'module';
import { readFileSync } from 'fs';

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import { glob } from 'tinyglobby';

export default function packageConfig(extraPlugins = []) {
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

  return async () => ({
    input: await glob('src/**/*.ts', { ignore: ['**/*.d.ts'] }),
    output: {
      dir: 'dist',
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: 'src',
      sourcemap: process.env.NODE_ENV !== 'production',
    },
    plugins: [
      ...extraPlugins,
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
}
