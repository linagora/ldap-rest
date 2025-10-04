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
          },
          declaration: true,
          declarationMap: false,
          sourceMap: true,
        }),
      ],
    },
    // UMD/ESM bundles for direct browser use
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
          declaration: false, // No types for bundles
          sourceMap: true,
        }),
        postcss({
          extract: 'ldap-tree-viewer.css',
          minimize: true,
          sourceMap: true,
        }),
      ],
    },
  ];
};
