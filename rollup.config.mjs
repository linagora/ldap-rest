/* eslint-disable no-undef */
import fs from 'fs';
import { builtinModules } from 'module';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { sortPackageJson } from 'sort-package-json';
import { writeFileSync } from 'fs';
import fg from 'fast-glob';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

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
  if (builtinModules.includes(bare) || builtinModules.includes(bare.split('/')[0]))
    return true;
  return externalPackages.some(dep => id === dep || id.startsWith(`${dep}/`));
};

async function getPluginEntries() {
  return (await fg('src/plugins/**/*.ts'))
    .map(file => file.replace(/^src\/plugins\//, ''))
    .sort();
}

async function getAbstractEntries() {
  return (await fg('src/abstract/**/*.ts'))
    .map(file => file.replace(/^src\/abstract\//, ''))
    .sort();
}

async function getSpecs() {
  return (await fg('static/schemas/**/*.json'))
    .map(file => file.replace(/^static\/schemas\//, ''))
    .sort();
}

async function getBrowserLibraries() {
  return (
    await fg('src/browser/**/*.ts', {
      ignore: ['**/*.test.ts', '**/*.css'],
    })
  )
    .map(file => file.replace(/^src\/browser\//, '').replace(/\.ts$/, ''))
    .sort();
}

pkg.exports = {
  '.': {
    import: './dist/bin/index.js',
    types: './dist/src/bin/index.d.ts',
  },
  './hooks': {
    types: './dist/src/hooks.d.ts',
  },
  './plugin': {
    import: './dist/abstract/plugin.js',
    types: './dist/src/abstract/plugin.d.ts',
  },
  './expressformatedresponses': {
    import: './dist/lib/expressFormatedResponses.js',
    types: './dist/src/lib/expressFormatedResponses.d.ts',
  },
  './ldapactions': {
    import: './dist/lib/ldapActions.js',
    types: './dist/src/lib/ldapActions.d.ts',
  },
};

export default async () => {
  const p = await getPluginEntries();
  p.forEach(plugin => {
    const name = plugin.replace(/\.ts$/, '');
    pkg.exports[`./plugin-${name.toLowerCase().replace(/\//g, '-')}`] = {
      import: `./dist/plugins/${name}.js`,
      types: `./dist/src/plugins/${name}.d.ts`,
    };
  });

  const a = await getAbstractEntries();
  a.forEach(abstract => {
    const name = abstract.replace(/\.ts$/, '');
    pkg.exports[`./abstract-${name.toLowerCase().replace(/\//g, '-')}`] = {
      import: `./dist/abstract/${name}.js`,
      types: `./dist/src/abstract/${name}.d.ts`,
    };
  });

  (await getBrowserLibraries()).forEach(browserLib => {
    const name = browserLib.toLowerCase().replace(/\//g, '-');
    pkg.exports[`./browser-${name}`] = {
      import: `./static/browser/${browserLib}.js`,
      types: `./dist/src/browser/${browserLib}.d.ts`,
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
        ...p.map(file => `${PLUGINS_SRC_DIR}/${file}`),
        ...a.map(file => `src/abstract/${file}`),
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
