# 0009 — One package per plugin

## Context

LDAP-Rest was one package: the server, every plugin and their options were
compiled together, and a deployment installed all of them whether it loaded
one or twenty. A plugin reached another through `server.loadedPlugins`, a
string-keyed registry, and a configuration named a module by a path in the
source tree (`core/ldap/groups`). The plugin API was a set of `ldap-rest`
sub-paths (`ldap-rest/plugin-ldap-groups`, …), generated from that tree.

Three needs drove the split: an operator should install and update only the
plugins they load; a plugin family should not be able to reach into another
except through a declared interface; and the option parser should not carry
options for plugins the server does not load, since a required option of an
unused plugin would stop the startup.

## Decision

- **One package per plugin**, under `packages/`, named after its feature:
  `@ldap-rest/ldap-groups`, `@ldap-rest/auth-token`, `@ldap-rest/james`, …,
  with one package per family when the family ships several plugins
  (`@ldap-rest/twake-collaboration` holds the groups and the spaces).
  `@ldap-rest/core` is the only mandatory package; every plugin package is
  optional and installed by the deployment. The keyed storage backends are
  packages of their own (`@ldap-rest/storage-{file,ldap,postgres,valkey}`),
  loaded by `--storage-backend` in the plugin's `prepare()`.
- **The umbrella** lives in `packages/ldap-rest` and publishes as
  `ldap-rest`: it keeps the CLI, the `core/…` plugin names and the non-plugin
  entries (`./plugin`, `./hooks`, `./ldapactions`,
  `./expressformatedresponses`, `./options`, `./abstract-*`, `./browser-*`,
  `./schema-*`). The repository root is the private `ldap-rest-monorepo`.
- **A package's `exports` is the plugin API.** The former
  `ldap-rest/plugin-*` sub-paths are removed in 3.0.0, with no deprecation
  window: a plugin is imported from the package the deployment installs.
- **The loader maps `core/…` to a package** through
  `packages/ldap-rest/src/pluginModules.json`, maintained by hand. The same
  table feeds `DM.canonicalModule`, so a plugin named by its `core/…` name or
  by its package is one module to the priority list and the duplicate guard.
- **A plugin that names another depends on its package as a peer**, exactly
  as its `optionDependencies` or its `dependencies` names it. `TwakeGroups
extends LdapGroups` is the one inheritance across families, and the Twake
  package declares `@ldap-rest/ldap-groups` as a peer for it. Behaviour that
  is not inheritance goes through a service
  (`docs/plugin-development/services.md`).
- **`Config` stays a type-only aggregate** in `packages/core/src/config/args.ts`.
  Each plugin types its options next to its class
  (`defineOptions`/`OptionsOf`), and the loader composes the template from
  the declarations of the plugins the command names; `options.full.ts` keeps
  the complete set for the build scripts and the tests.
- **Build**: npm workspaces, one Rollup build per package through
  `scripts/rollup.package.mjs`, and the umbrella's own `rollup.config.mjs`
  for its entries and generated `exports`. The version is 3.0.0.

## Consequences

- A deployment adds the plugin packages it loads to its `package.json`, and
  imports them from there; a `core/…` name still selects a plugin at startup.
  `docs/usage/upgrading.md` says what to change.
- `ldap-rest/plugin-*` imports break: the packages are the interface, and
  3.0.0 is a major release for that reason.
- An option of a plugin the command does not name is unknown: the startup
  report names it, and `--strict-options` refuses it. The Docker image
  therefore loads no plugin and declares the core options only.
- A plugin package ships its own declarations, and `api-extractor` gates the
  umbrella's entries only; the packages' `exports` are reviewed as their API.
- A driver (`pg`, `iovalkey`, …) is an optional peer of the package that
  needs it, so an install that does not use the backend does not pull it.
- `scripts/pack-umbrella.mjs` stages the bundled packages as real copies
  before packing: npm bundles only the `node_modules` of the packed package,
  and a workspace's dependencies are links.

The phased work, and what remains, is in the
[modularization plan](../../development/modularization-plan.md); the package
conventions are in [Workspace packages](../../development/packages.md).
