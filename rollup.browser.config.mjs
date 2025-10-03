import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';

export default {
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
      declaration: true,
      declarationDir: 'static/browser/types',
      sourceMap: true,
    }),
    postcss({
      extract: 'ldap-tree-viewer.css',
      minimize: true,
      sourceMap: true,
    }),
  ],
};
