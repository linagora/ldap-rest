import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { chmodSync } from 'fs';
import { dirname } from 'path';
import { mkdirSync } from 'fs';

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
      const outputFile = 'bin/index.js';
      try {
        chmodSync(outputFile, 0o755);
        console.log(`✅ chmod +x ${outputFile}`);
      } catch (error) {
        console.error(`❌ Unable to set permissions:`, error);
      }
    },
  };
};

export default {
  input: 'src/index.ts',
  output: {
    dir: 'bin',
    format: 'es',
    sourcemap: true,
    banner: '',
  },
  plugins: [
    nodeResolve({
      preferBuiltins: true,
      exportConditions: ['node'],
    }),
    commonjs(),
    json(),
    typescript({
      tsconfig: './tsconfig.json',
      module: 'ESNext',
      declaration: false,
      declarationMap: false,
      sourceMap: true,
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
    shebangPlugin(),
  ],

  external: [
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
  ],
};
