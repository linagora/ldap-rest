/* eslint-disable no-undef */
import fs from 'fs';
import { builtinModules } from 'module';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { sortPackageJson } from 'sort-package-json';
import { writeFileSync } from 'fs';
import { glob } from 'tinyglobby';

import stripCssDeclarations from '../../scripts/stripCssDeclarations.mjs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

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
    include: ['**/*.ts'],
    outDir: dir,
  }),
  stripCssDeclarations(),
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

const externalPackages = [
  // binary modules
  're2',

  // declared dependencies
  ...(pkg.dependencies ? Object.keys(pkg.dependencies) : []),
  ...(pkg.optionalDependencies ? Object.keys(pkg.optionalDependencies) : []),
];

// Mark as external: all Node builtins (with or without the `node:` prefix and
// their subpaths, e.g. `timers/promises`), plus declared dependencies and their
// subpaths (e.g. `csv-parse/sync`).
const external = id => {
  const bare = id.replace(/^node:/, '');
  if (
    builtinModules.includes(bare) ||
    builtinModules.includes(bare.split('/')[0])
  )
    return true;
  return externalPackages.some(dep => id === dep || id.startsWith(`${dep}/`));
};

async function getDemoEntries() {
  return (await glob('src/plugins/demo/**/*.ts')).sort();
}

async function getAbstractEntries() {
  return (await glob('src/abstract/**/*.ts'))
    .map(file => file.replace(/^src\/abstract\//, ''))
    .sort();
}

async function getSpecs() {
  return (await glob('../schemas/static/schemas/**/*.json'))
    .map(file => file.replace(/^\.\.\/schemas\/static\/schemas\//, ''))
    .sort();
}

async function getBrowserLibraries() {
  return (
    await glob('../browser/src/**/*.ts', {
      ignore: ['**/*.test.ts', '**/*.css', '**/*.d.ts'],
    })
  )
    .map(file => file.replace(/^\.\.\/browser\/src\//, '').replace(/\.ts$/, ''))
    .sort();
}

pkg.exports = {
  '.': {
    import: './dist/bin/index.js',
    types: './dist/bin/index.d.ts',
  },
  './hooks': {
    import: './dist/hooks.js',
    types: './dist/hooks.d.ts',
  },
  './plugin': {
    import: './dist/abstract/plugin.js',
    types: './dist/abstract/plugin.d.ts',
  },
  './expressformatedresponses': {
    import: './dist/lib/expressFormatedResponses.js',
    types: './dist/lib/expressFormatedResponses.d.ts',
  },
  './ldapactions': {
    import: './dist/lib/ldapActions.js',
    types: './dist/lib/ldapActions.d.ts',
  },
  './options': {
    import: './dist/options.js',
    types: './dist/options.d.ts',
  },
};

export default async () => {
  const demo = await getDemoEntries();

  const a = await getAbstractEntries();
  a.forEach(abstract => {
    const name = abstract.replace(/\.ts$/, '');
    pkg.exports[`./abstract-${name.toLowerCase().replace(/\//g, '-')}`] = {
      import: `./dist/abstract/${name}.js`,
      types: `./dist/abstract/${name}.d.ts`,
    };
  });

  (await getBrowserLibraries()).forEach(browserLib => {
    const name = browserLib.toLowerCase().replace(/\//g, '-');
    pkg.exports[`./browser-${name}`] = {
      import: `./static/browser/${browserLib}.js`,
      types: `./dist/browser/${browserLib}.d.ts`,
    };
  });

  (await getSpecs()).forEach(spec => {
    const name = spec.replace(/\.json$/, '').replace(/\//g, '-');
    pkg.exports[`./schema-${name.toLowerCase()}`] = {
      import: `./static/schemas/${spec}`,
      require: `./static/schemas/${spec}`,
    };
  });
  writeFileSync('package.json', sortPackageJson(JSON.stringify(pkg, null, 2)));

  return [
    {
      input: [
        'src/bin/index.ts',
        'src/bin/options.ts',
        'src/options.ts',
        'src/hooks.ts',
        'src/lib/ldapActions.ts',
        'src/lib/expressFormatedResponses.ts',
        'src/lib/parseConfig.ts',
        ...demo,
        ...a.map(file => `src/abstract/${file}`),
      ],
      output: {
        dir: 'dist',
        format: 'es',
        sourcemap: process.env.NODE_ENV !== 'production',
        banner: '',
        preserveModules: true,
      },
      plugins: [...commonPlugins('dist')],
      external,
    },
  ];
};
