# Workspace packages

The repository is an npm workspaces monorepo: each directory under
`packages/` is a package (`@ldap-rest/core`, `@ldap-rest/storage`, …), the
umbrella included (`packages/ldap-rest`, published as `ldap-rest`). The root
`package.json` is the private `ldap-rest-monorepo`: it holds the scripts, the
development dependencies and the workspace list, and publishes nothing. The
[modularization plan](modularization-plan.md) says which plugins move next.

Nothing outside a package names it: the builds, the type-check, the tests, the
coverage, the lint and the source checks find every package under
`packages/`. `scripts/packages.mjs` holds what they need to know.

## What a package holds

```text
packages/<name>/
  package.json        name, version, exports, peer dependencies
  rollup.config.mjs   export default packageConfig()
  tsconfig.json       extends ../../tsconfig.base.json
  src/                the sources
```

`packages/ldap-rest` is the umbrella: its `package.json` also carries the CLI
(`bin/`), the `files` it publishes and the packages it bundles, and its
`rollup.config.mjs` is its own, not `packageConfig()`: it emits the `./hooks`,
`./plugin`, `./abstract-*`, `./browser-*` and `./schema-*` entries beside the
modules. Its sources sit in `packages/ldap-rest/src`, its served `static` tree
in `packages/ldap-rest/static`.

- **`package.json`**: `exports` is the package's API. Every entry carries a
  `development` condition (the source file), `types` (the declaration) and
  `import` (the built module); the umbrella's generated entries have `types`
  and `import` only. Dependencies are declared as
  `peerDependencies`, `@ldap-rest/core` included, so the umbrella installs
  one copy of each; a driver only some deployments need is an optional peer.
- **`rollup.config.mjs`**: the shared configuration,
  `scripts/rollup.package.mjs`, builds `src/` into `dist/`, one module per
  source, and leaves every declared dependency external. A package that
  ships more than its modules passes extra Rollup plugins, or its own
  configuration as `packages/browser` does: `packages/core` copies
  `priority.json`.
- **`tsconfig.json`**: copy the one of `packages/storage`.
- **Data files**: a package ships its own only. `@ldap-rest/schemas` holds the
  JSON schemas under `static/schemas`, and `@ldap-rest/browser` its sources and
  the libraries it builds under `static/browser`. The umbrella composes the
  `static` tree it serves — and the browser declarations its `./browser-*`
  entries point at — from those packages with `scripts/composeAssets.mjs`; the
  build and the tests run it before reading them. A default option that names
  a schema reads the composed copy when the deployment has one, the package's
  own otherwise.

## Adding a package

1. Create the directory as above, and move the sources into `src/`.
2. Run `npm install`: npm links the package under
   `node_modules/@ldap-rest/`.
3. Add it to `packages/ldap-rest/package.json`, both in `dependencies` at its
   exact version and in `bundledDependencies`. Until phase 3 publishes the
   packages, the umbrella ships them in its own tarball.
4. Run `npm run sync:packages`, which writes the package's TypeScript paths
   into `tsconfig.json` and `tsconfig.api.json` and its sources into the
   coverage roots of `.c8rc.json` (c8 takes directories there, not globs).
5. Add the `core/…` names the package answers for to
   `packages/ldap-rest/src/pluginModules.json`. The umbrella keeps no sub-path
   for a plugin: a deployment imports it from the package.

`scripts/pack-umbrella.mjs` builds the published tarball: npm bundles only the
dependencies found in the packed package's own `node_modules`, and a
workspace's are links to `packages/`, so the script stages the umbrella with
real copies of the packages it bundles before packing. The release and the
image use it; `npm pack -w ldap-rest` would ship a tarball whose `@ldap-rest/*`
imports resolve to nothing.

`npm run check:packages`, part of `npm run check`, fails when step 3 or 4
was forgotten, and when a package's sources import a module its
`package.json` does not declare: a type import leaves every build here green
and fails in a consumer's tree instead.

`packages/ldap-rest/src/pluginModules.json` is the bridge between the two
names a plugin has:
it maps each `core/…` entry to the package — or the package's sub-path — that
provides it. The loader resolves a `core/…` entry through it, and
`DM.canonicalModule` reads it wherever a plugin is recognised rather than
loaded — the priority list, the deduplication of `--plugin` entries, and the
plugins that look for a dependency. A configuration may therefore name either
spelling, and a plugin may depend on either.

## Commands

| Command                          | What it does                                                     |
| -------------------------------- | ---------------------------------------------------------------- |
| `npm run build:packages`         | Builds every package, dependencies first                         |
| `npm run build:assets`           | Composes the umbrella's `static` tree from the packages          |
| `./.dev.mk buildpackages`        | The same, for the packages whose sources or dependencies changed |
| `npm run sync:packages`          | Writes the TypeScript paths and coverage roots of every package  |
| `npm run check:packages`         | Fails when those are stale or the umbrella misses a package      |
| `node scripts/packages.mjs list` | Prints the package directories in build order                    |

`npm run build:dev`, `npm run test:dev` and `npm run build:prod` build the
packages first; so do `check:api` and `snapshot:api`, which read the built
declarations.

## Publishing

`scripts/publish-packages.mjs` publishes the packages in dependency order
(`node scripts/publish-packages.mjs --tag latest`), skipping a version the
registry already has; the umbrella follows from its own tarball, which bundles
them. Every manifest carries the tag's version, and every `@ldap-rest/*` pin
equals the version of the package that names it: `npm run check` and CI
refuse otherwise. Nothing is published by `npm run check` or the test
workflow.

The packages step of the release stays off until each package has been
published once **by hand**, with a token: npm has no pending publisher, so a
package that was never published cannot trust the workflow yet. Then configure
that package's trusted publisher for this repository and the `release`
workflow, and set the repository variable `NPM_PUBLISH_PACKAGES=true`. Until
then the umbrella keeps publishing alone.

## How a package is resolved

The type-check and the tests read the sources, not `dist/`: `tsconfig.json`
maps every `exports` entry to its `development` file, and tsx follows the
same paths. `tsconfig.api.json` maps the same entries to their `types` file,
for the API reports.

Both maps are generated from `exports`, one path per entry, so an import that
Node would refuse (`ERR_PACKAGE_PATH_NOT_EXPORTED`) fails the type-check too.
Edit `exports`, then run `npm run sync:packages`; never edit the paths by
hand.
