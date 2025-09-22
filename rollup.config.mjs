/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { readdir } from 'fs/promises';
import { extname } from 'path';
import sort from 'sort-package-json';
import { writeFileSync } from 'fs';

import pkg from './package.json' with { type: 'json' };

const PLUGINS_SRC_DIR = 'src/plugins';

const commonPlugins = dir => [
  commonjs(),
  json(),
  typescript({
    tsconfig: './tsconfig.json',
    module: 'ESNext',
    declaration: true,
    declarationDir: dir,
    declarationMap: false,
    sourceMap: process.env.NODE_ENV !== 'production',
    include: ['src/**/*'],
    outDir: dir,
  }),
  process.env.NODE_ENV === 'production' &&
    terser({
      compress: {
        drop_console: false,
        drop_debugger: true,
      },
      mangle: {
        keep_classnames: true,
        keep_fnames: true,
      },
      format: {
        comments: false,
      },
    }),
];

const external = [
  // Builtins modules
  'fs',
  'path',
  'os',
  'crypto',
  'events',
  'stream',
  'util',
  'buffer',
  'querystring',
  'url',
  'http',
  'https',
  'net',
  'tls',
  'zlib',

  // binary modules
  're2',

  // declared dependencies
  ...(pkg.dependencies ? Object.keys(pkg.dependencies) : []),
  ...(pkg.optionalDependencies ? Object.keys(pkg.optionalDependencies) : []),
];

const corePlugins = [];
async function getPluginEntries() {
  const files = await readdir(PLUGINS_SRC_DIR);
  return files.filter(file => extname(file) === '.ts');
}

pkg.exports = {
  '.': {
    import: './dist/bin/index.js',
    types: './dist/src/bin/index.d.ts',
  },
  hooks: {
    types: './dist/src/hooks.d.ts',
  },
};

export default async () => {
  const p = await getPluginEntries();
  p.forEach(plugin => {
    const name = plugin.replace(/\.ts$/, '');
    pkg.exports[`plugin-${name.toLowerCase()}`] = {
      import: `./dist/plugins/${name}.js`,
      types: `./dist/src/plugins/${name}.d.ts`,
    };
  });
  writeFileSync('package.json', sort(JSON.stringify(pkg, null, 2)));
  return [
    {
      input: [
        'src/bin/index.ts',
        ...p.map(file => `${PLUGINS_SRC_DIR}/${file}`),
      ],
      output: {
        dir: 'dist',
        format: 'es',
        sourcemap: process.env.NODE_ENV !== 'production',
        banner: '',
        preserveModules: true,
      },
      plugins: commonPlugins('dist'),
      external,
    },
  ];
};
