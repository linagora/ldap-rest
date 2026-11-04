# Workspace packages

The repository is an npm workspaces monorepo: each directory under
`packages/` is a package (`@ldap-rest/core`, `@ldap-rest/storage`, …), and the
root is the `ldap-rest` umbrella. The
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

- **`package.json`**: `exports` is the package's API. Every entry carries a
  `development` condition (the source file), `types` (the declaration) and
  `import` (the built module). Dependencies are declared as
  `peerDependencies`, `@ldap-rest/core` included, so the umbrella installs
  one copy of each; a driver only some deployments need is an optional peer.
- **`rollup.config.mjs`**: the shared configuration,
  `scripts/rollup.package.mjs`, builds `src/` into `dist/`, one module per
  source, and leaves every declared dependency external. A package that
  ships more than its modules passes extra Rollup plugins:
  `packages/core` copies `priority.json`.
- **`tsconfig.json`**: copy the one of `packages/storage`.

## Adding a package

1. Create the directory as above, and move the sources into `src/`.
2. Run `npm install`: npm links the package under
   `node_modules/@ldap-rest/`.
3. Add it to the umbrella's `package.json`, both in `dependencies` at its
   exact version and in `bundledDependencies`. Until phase 3 publishes the
   packages, the umbrella ships them in its own tarball.
4. Run `npm run sync:packages`, which writes the package's TypeScript paths
   into `tsconfig.json` and `tsconfig.api.json`, its sources into the
   coverage roots of `.c8rc.json` (c8 takes directories there, not globs), and
   every shim's `core/…` name into `src/pluginModules.json`.
5. Keep the former sub-paths of the umbrella as one-line re-exports of the
   package, so the split breaks no import.

`npm run check:packages`, part of `npm run check`, fails when step 3 or 4
was forgotten, and when a package's sources import a module its
`package.json` does not declare: a type import leaves every build here green
and fails in a consumer's tree instead.

`src/pluginModules.json` is the bridge between the two names a plugin has:
it maps each `core/…` entry to the package its shim re-exports, and
`DM.canonicalModule` reads it wherever a plugin is recognised rather than
loaded — the priority list, the deduplication of `--plugin` entries, and the
plugins that look for a dependency. A configuration may therefore name either
spelling, and a plugin may depend on either.

## Commands

| Command                          | What it does                                                     |
| -------------------------------- | ---------------------------------------------------------------- |
| `npm run build:packages`         | Builds every package, dependencies first                         |
| `./.dev.mk buildpackages`        | The same, for the packages whose sources or dependencies changed |
| `npm run sync:packages`          | Writes the TypeScript paths and coverage roots of every package  |
| `npm run check:packages`         | Fails when those are stale or the umbrella misses a package      |
| `node scripts/packages.mjs list` | Prints the package directories in build order                    |

`npm run build:dev`, `npm run test:dev` and `npm run build:prod` build the
packages first; so do `check:api` and `snapshot:api`, which read the built
declarations.

## How a package is resolved

The type-check and the tests read the sources, not `dist/`: `tsconfig.json`
maps every `exports` entry to its `development` file, and tsx follows the
same paths. `tsconfig.api.json` maps the same entries to their `types` file,
for the API reports.

Both maps are generated from `exports`, one path per entry, so an import that
Node would refuse (`ERR_PACKAGE_PATH_NOT_EXPORTED`) fails the type-check too.
Edit `exports`, then run `npm run sync:packages`; never edit the paths by
hand.
