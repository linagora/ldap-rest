/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { chmodSync } from 'fs';
import { readdir } from 'fs/promises';
import { basename, extname, join } from 'path';

const PLUGINS_SRC_DIR = 'src/plugins';
const PLUGINS_OUT_DIR = 'dist/plugins';

// Plugin personnalisé pour ajouter le shebang et les permissions
const shebangPlugin = () => {
  return {
    name: 'shebang-plugin',
    generateBundle(options, bundle) {
      // Ajouter le shebang au début du fichier
      for (const fileName in bundle) {
        const file = bundle[fileName];
        if (file.type === 'chunk' && file.isEntry) {
          file.code = '#!/usr/bin/env node\n' + file.code;
        }
      }
    },
    writeBundle(options, bundle) {
      const outputFile = 'dist/bin/index.js';
      try {
        chmodSync(outputFile, 0o755);
        console.log(`✅ chmod +x ${outputFile}`);
      } catch (error) {
        console.error(`❌ Unable to set permissions:`, error);
      }
    },
  };
};

const commonPlugins = (dir) => [
  commonjs(),
  json(),
  typescript({
    tsconfig: './tsconfig.json',
    module: 'ESNext',
    declaration: false,
    declarationMap: false,
    sourceMap: true,
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
];

async function getPluginEntries() {
  try {
    const files = await readdir(PLUGINS_SRC_DIR);
    const tsFiles = files.filter(file => extname(file) === '.ts');

    return tsFiles.map(file => {
      const name = basename(file, '.ts');
      console.log('DEBUG', `${PLUGINS_OUT_DIR}/${name}.mjs`)
      return {
        input: `${PLUGINS_SRC_DIR}/${file}`,
        output: {
          dir: PLUGINS_OUT_DIR,
          name: `${name}.mjs`,
          //file: `${PLUGINS_OUT_DIR}/${name}.mjs`,
          format: 'es',
          sourcemap: true,
        },
        external: ['express'], // Express reste externe
        plugins: [
          nodeResolve({
            preferBuiltins: true,
          }),
          ...commonPlugins(PLUGINS_OUT_DIR),
        ],
      };
    });
  } catch (error) {
    console.error('Unable to build plugins:', error);
    return [];
  }
}

export default async () => {
  const pluginEntries = await getPluginEntries();
  return [
    // Core-plugins
    ...pluginEntries,
    // main
    {
      input: 'src/index.ts',
      output: {
        dir: 'dist/bin',
        format: 'es',
        sourcemap: true,
        banner: '',
      },
      plugins: [
        nodeResolve({
          preferBuiltins: true,
          exportConditions: ['node'],
        }),
        ...commonPlugins('dist/bin'),
        shebangPlugin(),
      ],
      external,
    },
  ];
};
