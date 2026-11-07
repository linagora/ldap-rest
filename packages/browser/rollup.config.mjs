import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';
import { glob } from 'tinyglobby';

import stripCssDeclarations from '../../scripts/stripCssDeclarations.mjs';

async function getBrowserLibraries() {
  return (
    await glob('src/**/*.ts', {
      ignore: ['**/*.test.ts', '**/*.css', '**/*.d.ts'],
    })
  ).sort();
}

/** Copy the individual modules beside the bundles the static plugin serves */
const copyModules = () => ({
  name: 'copy-browser-modules',
  writeBundle() {
    const copy = (src, dest) => {
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src)) {
        const from = join(src, entry);
        const to = join(dest, entry);
        if (statSync(from).isDirectory()) copy(from, to);
        else if (from.endsWith('.js') || from.endsWith('.js.map'))
          copyFileSync(from, to);
      }
    };
    copy('dist', 'static/browser');
    copyFileSync(
      'src/shared/styles/common-demo.css',
      'static/browser/common-demo.css'
    );
  },
});

export default async () => {
  rmSync('static/browser', { recursive: true, force: true });
  const browserFiles = await getBrowserLibraries();

  return [
    // Individual modules for npm imports
    {
      input: browserFiles,
      output: {
        dir: 'dist',
        format: 'es',
        sourcemap: true,
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
      plugins: [
        commonjs(),
        postcss({
          extract: false,
          inject: false,
          modules: false,
        }),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'dist',
            declarationDir: 'dist',
            declaration: true,
          },
          declarationMap: false,
          sourceMap: true,
        }),
        stripCssDeclarations(),
        copyModules(),
      ],
    },
    // UMD/ESM bundles for shared utilities
    {
      input: 'src/shared/index.ts',
      output: [
        {
          file: 'static/browser/shared.js',
          format: 'umd',
          name: 'MiniDmShared',
          sourcemap: true,
          exports: 'named',
        },
        {
          file: 'static/browser/shared.esm.js',
          format: 'esm',
          sourcemap: true,
        },
        {
          file: 'static/browser/shared.min.js',
          format: 'umd',
          name: 'MiniDmShared',
          sourcemap: true,
          exports: 'named',
          plugins: [terser()],
        },
      ],
      plugins: [
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'static/browser',
            declaration: false,
            declarationDir: undefined,
          },
          sourceMap: true,
        }),
      ],
    },
    // UMD/ESM bundles for ldap-tree-viewer
    {
      input: 'src/ldap-tree-viewer/index.ts',
      output: [
        {
          file: 'static/browser/ldap-tree-viewer.js',
          format: 'umd',
          name: 'LdapTreeViewer',
          sourcemap: true,
          exports: 'named',
        },
        {
          file: 'static/browser/ldap-tree-viewer.esm.js',
          format: 'esm',
          sourcemap: true,
        },
        {
          file: 'static/browser/ldap-tree-viewer.min.js',
          format: 'umd',
          name: 'LdapTreeViewer',
          sourcemap: true,
          exports: 'named',
          plugins: [terser()],
        },
      ],
      plugins: [
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'static/browser',
            declaration: false, // No types for bundles
            declarationDir: undefined, // Override tsconfig.browser.json
          },
          sourceMap: true,
        }),
        postcss({
          extract: 'ldap-tree-viewer.css',
          minimize: true,
          sourceMap: true,
        }),
      ],
    },
    // UMD/ESM bundles for ldap-user-editor
    {
      input: 'src/ldap-user-editor/index.ts',
      output: [
        {
          file: 'static/browser/ldap-user-editor.js',
          format: 'umd',
          name: 'LdapUserEditor',
          sourcemap: true,
          exports: 'named',
        },
        {
          file: 'static/browser/ldap-user-editor.esm.js',
          format: 'esm',
          sourcemap: true,
        },
        {
          file: 'static/browser/ldap-user-editor.min.js',
          format: 'umd',
          name: 'LdapUserEditor',
          sourcemap: true,
          exports: 'named',
          plugins: [terser()],
        },
      ],
      plugins: [
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'static/browser',
            declaration: false, // No types for bundles
            declarationDir: undefined, // Override tsconfig.browser.json
          },
          sourceMap: true,
        }),
        postcss({
          extract: 'ldap-user-editor.css',
          minimize: true,
          sourceMap: true,
        }),
      ],
    },
    // UMD/ESM bundles for ldap-group-editor
    {
      input: 'src/ldap-group-editor/index.ts',
      output: [
        {
          file: 'static/browser/ldap-group-editor.js',
          format: 'umd',
          name: 'LdapGroupEditor',
          sourcemap: true,
          exports: 'named',
        },
        {
          file: 'static/browser/ldap-group-editor.esm.js',
          format: 'esm',
          sourcemap: true,
        },
        {
          file: 'static/browser/ldap-group-editor.min.js',
          format: 'umd',
          name: 'LdapGroupEditor',
          sourcemap: true,
          exports: 'named',
          plugins: [terser()],
        },
      ],
      plugins: [
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'static/browser',
            declaration: false, // No types for bundles
            declarationDir: undefined, // Override tsconfig.browser.json
          },
          sourceMap: true,
        }),
        postcss({
          extract: false, // Reuse ldap-user-editor.css
          minimize: false,
          sourceMap: false,
        }),
      ],
    },
    // UMD/ESM bundles for ldap-unit-editor
    {
      input: 'src/ldap-unit-editor/index.ts',
      output: [
        {
          file: 'static/browser/ldap-unit-editor.js',
          format: 'umd',
          name: 'LdapUnitEditor',
          sourcemap: true,
          exports: 'named',
        },
        {
          file: 'static/browser/ldap-unit-editor.esm.js',
          format: 'esm',
          sourcemap: true,
        },
        {
          file: 'static/browser/ldap-unit-editor.min.js',
          format: 'umd',
          name: 'LdapUnitEditor',
          sourcemap: true,
          exports: 'named',
          plugins: [terser()],
        },
      ],
      plugins: [
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'static/browser',
            declaration: false, // No types for bundles
            declarationDir: undefined, // Override tsconfig.browser.json
          },
          sourceMap: true,
        }),
        postcss({
          extract: false, // Reuse ldap-user-editor.css
          minimize: false,
          sourceMap: false,
        }),
      ],
    },
    // UMD/ESM bundles for ldap-browser
    {
      input: 'src/ldap-browser/index.ts',
      output: [
        {
          file: 'static/browser/ldap-browser.js',
          format: 'umd',
          name: 'LdapBrowser',
          sourcemap: true,
          exports: 'named',
        },
        {
          file: 'static/browser/ldap-browser.esm.js',
          format: 'esm',
          sourcemap: true,
        },
        {
          file: 'static/browser/ldap-browser.min.js',
          format: 'umd',
          name: 'LdapBrowser',
          sourcemap: true,
          exports: 'named',
          plugins: [terser()],
        },
      ],
      plugins: [
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            outDir: 'static/browser',
            declaration: false, // No types for bundles
            declarationDir: undefined, // Override tsconfig.browser.json
          },
          sourceMap: true,
        }),
        postcss({
          extract: 'ldap-browser.css',
          minimize: true,
          sourceMap: true,
        }),
      ],
    },
  ];
};
