import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';
import fg from 'fast-glob';

async function getBrowserLibraries() {
  return (
    await fg('src/browser/**/*.ts', {
      ignore: ['**/*.test.ts', '**/*.css'],
    })
  ).sort();
}

export default async () => {
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
        resolve({
          browser: true,
        }),
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
      ],
    },
    // UMD/ESM bundles for shared utilities
    {
      input: 'src/browser/shared/index.ts',
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
        resolve({
          browser: true,
        }),
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
            declaration: false,
            declarationDir: undefined,
          },
          sourceMap: true,
        }),
      ],
    },
    // UMD/ESM bundles for ldap-tree-viewer
    {
      input: 'src/browser/ldap-tree-viewer/index.ts',
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
        resolve({
          browser: true,
        }),
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
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
      input: 'src/browser/ldap-user-editor/index.ts',
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
        resolve({
          browser: true,
        }),
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
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
      input: 'src/browser/ldap-group-editor/index.ts',
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
        resolve({
          browser: true,
        }),
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
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
      input: 'src/browser/ldap-unit-editor/index.ts',
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
        resolve({
          browser: true,
        }),
        commonjs(),
        typescript({
          tsconfig: './tsconfig.browser.json',
          compilerOptions: {
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
  ];
};
