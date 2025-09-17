import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { writeFileSync, chmodSync } from 'fs';
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
      // Définir les permissions après l'écriture du fichier
      const outputFile = options.file;
      if (outputFile) {
        try {
          // Créer le répertoire si il n'existe pas
          const dir = dirname(outputFile);
          mkdirSync(dir, { recursive: true });

          // Définir les permissions 755 (rwxr-xr-x)
          chmodSync(outputFile, 0o755);
          console.log(`✅ Permissions 755 définies sur ${outputFile}`);
        } catch (error) {
          console.error(
            `❌ Erreur lors de la définition des permissions:`,
            error
          );
        }
      }
    },
  };
};

export default {
  input: 'src/index.ts',
  output: {
    file: 'bin/server.js',
    format: 'cjs', // CommonJS pour Node.js
    sourcemap: true,
    banner: '', // Le shebang sera ajouté par notre plugin
  },
  plugins: [
    // Résoudre les modules Node.js
    nodeResolve({
      preferBuiltins: true,
      exportConditions: ['node'],
    }),

    // Convertir les modules CommonJS
    commonjs(),

    // Compiler TypeScript
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
          drop_console: false, // Garder les console.log pour un serveur
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

    // Plugin personnalisé pour shebang et permissions
    shebangPlugin(),
  ],

  // Exclure les modules Node.js natifs du bundle
  external: [
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
  ],
};
