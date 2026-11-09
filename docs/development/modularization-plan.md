# Modularization plan

How the remaining architecture work is sequenced: [#397] and the five
`code-quality` issues that depend on it or prepare it. The plan is a roadmap,
not a contract; update it as the work lands.

## Open issues

| Issue  | Subject                                             | Role           | Size   |
| ------ | --------------------------------------------------- | -------------- | ------ |
| [#397] | Split the repository into `@ldap-rest/*` modules    | Final step     | Major  |
| [#549] | Architecture pages, decision records, comment check | Part 2 remains | Medium |

[#397] targets `3.0.0`, where the former sub-paths are removed after the
internal split, `ldap-rest/plugin-*` included. [#593], [#594], [#595] and
[#603] are done.

## What blocks #397 today

`@ldap-rest/core`, the plugin packages, `browser` and `schemas` are packages
of their own. What remains is the umbrella:

- It still composes the options in `src/options.ts` and passes them to the
  core `DM`; the core itself imports no family.
- Its build composes `static/` from the browser and schemas packages, and
  still generates the `./browser-*` and `./schema-*` exports from them.

Between plugin families the only coupling left is
`TwakeGroups extends LdapGroups`, accepted as a peer dependency (decision 3).

## Target architecture

An npm workspaces monorepo with one package per plugin and an umbrella that
keeps the CLI, the `core/…` namespace and the non-plugin entries. Today's
`./plugin-*` entries already separate the plugins:

```text
packages/
  core/                   @ldap-rest/core
  ldap-externalusers/     @ldap-rest/ldap-externalusers
  ldap-groups/            @ldap-rest/ldap-groups
  ldap-organizations/     @ldap-rest/ldap-organizations
  auth-token/             @ldap-rest/auth-token
  james/                  @ldap-rest/james
  twake-appaccounts/      @ldap-rest/twake-appaccounts
  scim/                   @ldap-rest/scim
  bcl/                    @ldap-rest/bcl
  config-api/             @ldap-rest/config-api
  metrics/                @ldap-rest/metrics
  rabbitmq/               @ldap-rest/rabbitmq
  static/                 @ldap-rest/static
  weblogs/                @ldap-rest/weblogs
  browser/                @ldap-rest/browser
  schemas/                @ldap-rest/schemas
  ldap-rest/              umbrella package (main CLI and re-exports)
```

The list is illustrative: the package name follows the plugin's feature name,
and each package may expose more than one entry point when the plugin already
has several (`twake-appaccounts` keeps its API and consistency classes
together, `scim` its modules).

Rules:

- `core` depends on no plugin. A plugin package may depend on another plugin
  when its behaviour needs it, as `TwakeGroups extends LdapGroups`: declare it
  in the package's `package.json` as a peer dependency, exactly as its
  `optionDependencies` or `dependencies` ask to have loaded (decision 7).
  Cross-family behaviour otherwise goes through services
  (`packages/core/src/lib/services`) or hooks.
- `TwakeGroups extends LdapGroups` stays the inheritance it is; the base does
  not move to `core` (decision 3).
- `ldap-rest` stays the entry package: it depends on `@ldap-rest/core` and on
  the two packages that ship what it serves, `@ldap-rest/browser` and
  `@ldap-rest/schemas`; every plugin package is optional. Its build composes
  `static/` from those two. A deployment installs the plugins it needs
  (`npm install @ldap-rest/james`); the umbrella keeps the `ldap-rest`
  CLI and the `core/…` namespace, but not the former
  `ldap-rest/plugin-*` sub-paths: 3.0.0 removes them, and a deployment
  imports each plugin from the package it installs. The split is therefore
  breaking.
- A plugin package ships the commands that belong to its feature:
  `@ldap-rest/ldap-externalusers` owns `cleanup-external-users`,
  `@ldap-rest/james` owns `sync-james`, and
  `@ldap-rest/twake-appaccounts` owns `sync-app-accounts`. A command is
  installed with its plugin package, not with `ldap-rest`: installing
  `ldap-rest` alone no longer provides them.
- A script that needs a `DM` uses `@ldap-rest/core` and its own option set, not
  the umbrella or another plugin package: a plugin package cannot depend on
  `ldap-rest` without a cycle. `ldapActions`, the parser and the services are
  core, so using them loads no plugin.
- Until phase 3 publishes `@ldap-rest/core`, the umbrella bundles it nested
  under its own `node_modules`, out of reach of an external plugin: such a
  plugin imports the umbrella sub-paths (`ldap-rest/plugin`,
  `ldap-rest/hooks`, …). No plugin package that depends on `@ldap-rest/core`
  is extracted before the core is published.
- A plugin package is installed by the deployment, not by `ldap-rest`; being
  installed does not load it. `DM` loads only the `--plugin` entries and the
  priority list, so `cleanup-external-users` in `ldap-externalusers` never
  loads the LDAP plugins (and there is no aggregate `@ldap-rest/ldap` package).
  The loader maps `core/…` to the package that provides it: naming a plugin
  whose package is absent is an error at startup, an uninstalled optional
  plugin in the priority list is skipped. Until that loader exists, the map is
  the umbrella's (`src/pluginModules.json`, read by `DM.canonicalModule`): a
  `DM` built from the core alone knows only the spellings it is handed, so an
  embedder naming a plugin by its package gets neither its rank in the
  priority list nor the duplicate-load guard.
- The umbrella keeps only the main `ldap-rest` command, the loader that maps
  `core/…` to plugin packages, and the `DM` subclass that supplies the plugin
  tree.
- The parser is two-phase: it reads the core options and the `--plugin` entries
  first, imports the named plugin packages, collects their `optionDefinitions`,
  then parses the full configuration. The umbrella does not import every
  plugin's option set; `src/options.ts` is the temporary composition for the
  monolith, not the target.
- A plugin package exports its option set next to its class. A named plugin
  whose package is absent is an error; an optional package the configuration
  does not name is not needed.
- Each package builds on its own with a shared configuration; the umbrella
  re-exports.

## Phases

### Phase 0 — Guardrails and quick wins

1. [#603]: enable the type-checked rules on `test/**/*.ts`, fix the 31
   `no-floating-promises` and 24 `await-thenable` reports, add the block to CI.
2. [#549], part 1: `docs/architecture/README.md` (module map, life of a
   request, life of a write) and the decision records for the decisions already
   in place. Add `scripts/check-comments.sh` with a baseline that may only
   shrink. The GitHub ruleset change can land separately.
3. [#595], part 1: `@microsoft/api-extractor` on the five main entry points
   (`ldap-rest`, `./plugin`, `./hooks`, `./ldapactions`,
   `./expressformatedresponses`), reports under `etc/api/`, wired into the
   `contracts` job. The 66 `./plugin-*` entries wait for phase 3.

Outcome: CI catches regressions, the current architecture is documented, and
the public types have a baseline.

### Phase 1 — Decouple the core

1. [#593]:
   - typed entity registry replacing the six hand-written loops;
   - `GroupsApi`, `OrganizationsApi`, `TrashApi`, `PasswordPolicyApi`,
     `TwakeGroupsApi`, `AuthenticatorsInfo` service interfaces;
   - replace the 68 `loadedPlugins` reads and the 17 `requirePlugin` uses;
   - move `ChangesToNotify` out of `plugins/ldap/onChange.ts` and the SCIM
     types out of `plugins/scim/` into `packages/core/src/lib/`;
   - ESLint: forbid `loadedPlugins` under `src/plugins/**` and imports between
     plugin families.
2. [#594]: extract the operation pipeline into `packages/core/src/lib/ldap/operations.ts`,
   bring `ldapActions.ts` under 400 lines, add the file-size test, move the
   ESLint exemption, add the type test on `ldap-rest/ldapactions`.
3. Options refactor (**done**): `packages/core/src/config/args.ts` holds the
   core options only; `src/options.ts` composes the family option sets; `DM`
   accepts the template as a constructor parameter; `priority.json` moved to
   `packages/core/src/config/priority.json`.

Outcome: `packages/core/src/hooks.ts` imports no plugin, the core reads no `loadedPlugins`,
families do not import each other, and `ldapActions` is a stable façade.

### Phase 2 — Workspaces and extraction

1. (**done**) Set up npm workspaces, `packages/`, a shared `tsconfig.base.json`
   and per-package builds. Nothing outside a package names it:
   `scripts/packages.mjs` builds the packages in dependency order and derives
   their TypeScript paths from their `exports`, see
   [Workspace packages](packages.md).
2. (**done**) Extract `@ldap-rest/core`, with the `ldap-rest` umbrella depending
   on it and re-exporting the existing entry points. `ConfigTemplate` and
   `ConfigEntry` are exported from the core; the umbrella re-exports the whole
   core API. The core is bundled in the umbrella tarball until phase 3
   publishes the scoped packages.
3. (**done**) Make the parser two-phase before the first optional package
   leaves the monolith: `composeOptions` in `src/options.ts` reads `--plugin`,
   imports those plugins and collects their `optionDefinitions`; the
   umbrella's default template keeps the core options only. `src/options.full.ts`
   keeps the complete set for the build scripts and the tests.
4. Extract one package per plugin, grouped for the order: storage → auth →
   ldap → scim → twake → misc. (**started**) The storage plugin, its options
   and its backends live in `packages/storage` (`@ldap-rest/storage`); the
   umbrella keeps the `./plugin-storage*` shims and bundles the package until
   phase 3 publishes it. Splitting it into one package per backend is [#651].
   (**done**) The authentication and authorization plugins are one package
   per plugin (`@ldap-rest/auth-token`, `@ldap-rest/authz-linid1`, …), each
   declaring its option set next to its class; `ldap-rest/plugin-auth-*` stay
   as shims and `ldap-rest/plugin-auth-auth.options` re-exports every option
   set.
   (**done**) The LDAP plugins are the same, `@ldap-rest/ldap-groups`,
   `@ldap-rest/ldap-organizations`, …; `ldap-rest/plugin-ldap-*` stay as
   shims, `plugin-ldap-ldap.options` re-exports every option set, and the
   deprecated `plugin-ldap-organization` still names the organizations
   plugin. Four of them read another one's options and depend on its package
   (see the decisions below).
   (**done**) The SCIM family is `@ldap-rest/scim`, exposing the plugin and
   its modules; the umbrella keeps the `./plugin-scim-*` shims and the
   `core/scim` alias.
   (**done**) The Twake family is one package per feature:
   `@ldap-rest/james`, `@ldap-rest/twake-drive`, `@ldap-rest/twake-calendar`,
   `@ldap-rest/twake-appaccounts`, `@ldap-rest/twake-mail-migration`,
   `@ldap-rest/twake-lifecycle`, `@ldap-rest/twake-provisioning` and
   `@ldap-rest/twake-collaboration`; the umbrella keeps the
   `./plugin-twake-*` shims and the `core/twake/…` names.
   (**done**) The standalone plugins are one package each:
   `@ldap-rest/bcl`, `@ldap-rest/config-api`, `@ldap-rest/metrics`,
   `@ldap-rest/rabbitmq`, `@ldap-rest/static` and `@ldap-rest/weblogs`; the
   umbrella keeps the former `src/plugins/*.ts` paths as shims. The static
   plugin finds the deployment's `static` directory upwards, as the schema
   defaults do, since that directory belongs to the umbrella.
5. (**done**) Extract `browser` and `schemas` as `@ldap-rest/browser` and
   `@ldap-rest/schemas`. The browser package builds the individual modules,
   the bundles and the declarations the former `./browser-*` entries name;
   the schemas package ships the JSON files. The umbrella composes `static/`
   from both with `scripts/composeAssets.mjs`, so the served tree and the
   historical sub-paths stay where they were.
6. After each step: `npm run test:dev`, `npm run check`,
   `npm run check:openapi`, `npm run check:options`, and the `contracts` job.
7. Update the Dockerfile, the `bin/` scripts, the examples and the docs.

Outcome: a modular repository, with `ldap-rest` still installable and
compatible.

### Phase 3 — Contracts and finalization

1. [#595], part 2: one api-extractor report per remaining public sub-path,
   and non-additive diffs refused by `contracts`. The `./plugin-*` reports
   and their entries go away with the shims.
2. [#549], part 2: the modularization decision record, a shrinking comment
   baseline, and the `require_code_owner_review` ruleset.
3. (**done**) Remove every `ldap-rest/plugin-*` entry, the `src/plugins/*.ts`
   shims and the `./plugin-*` api-extractor reports. A plugin is imported from
   the `@ldap-rest/*` package the deployment installs.
4. Publish the scoped packages. With the first published plugin package, add
   the `3.0.0` upgrade note and the CHANGELOG breaking entry: a deployment
   must add the plugin packages it loads to its `package.json`, change every
   `ldap-rest/plugin-*` import to its package, and expect the optional
   commands to move with their plugin package.
5. Close [#397].

## Branch strategy

Phase 0 lands on `master`: it is non-breaking, and #603 fixes test bugs that
matter to the default branch too. Rebase `v3.0` onto `master` before phase 1,
so the 3.0 work starts from a green, guarded base, and again before each phase:
`v3.0` only carries the work of the current phase, so its history stays a line
on top of `master`. Phases 1 to 3 land on `v3.0`.

## Order

```text
#603 ───────────────┐
#549 (part 1) ──────┼──> Phase 0
#595 (part 1) ──────┘
                     │
#593 ────────────────┼──> Phase 1 ──> #397 (Phase 2) ──> #595/#549 (part 2)
#594 ────────────────┘
```

[#603] and [#549] part 1 can start in parallel. [#595] part 1 is a short
spike. [#593] and [#594] can then run in parallel, but both touch the core:
freeze new cross-family imports and new `loadedPlugins` reads from the start of
phase 1.

## Decisions to make

1. **Granularity** (**decided**): one package per plugin, as today's
   `./plugin-*` entries are split.
2. **Versioning** (**decided**): 3.0.0 with the former sub-paths removed,
   `ldap-rest/plugin-*` included, on the `v3.0` branch. No deprecation
   window: the packages are the interface.
3. **`TwakeGroups extends LdapGroups`** (**decided**): keep the inheritance;
   the Twake plugin package depends on `@ldap-rest/ldap-groups` as a peer.
4. **`Config` type**: type-only aggregate in `core` (recommended to start), or
   split per package with declaration merging?
5. **Build**: Rollup per package (consistent with today) or `tsc` with
   generated exports?
6. **Mandatory plugins** (**decided**): only `@ldap-rest/core`. Every plugin
   package is optional and installed by the deployment.
7. **A plugin that names another one** (**decided**): it depends on that
   plugin's package, as a peer, exactly as its `optionDependencies` or its
   `dependencies` names it — `@ldap-rest/ldap-groups` and
   `@ldap-rest/ldap-departmentsync` on `ldap-organizations`,
   `ldap-externalusers` on `ldap-groups`, `ldap-enterpriserules` on both,
   `ldap-flatgeneric` on `ldap-departmentsync`, `ldap-accountlifecycle` on
   `ldap-flatgeneric`. Configuration shared by two plugins is not a service,
   so the attributes an entry uses to name its organization stay declared
   once, in the plugin that owns them; a plugin another one only needs
   registered is a peer all the same, or a standalone install reports every
   peer met and fails at startup on a module nobody installed.
8. **Monorepo layout** (**decided, later**): the umbrella itself moves to
   `packages/ldap-rest/`, and the repository root `package.json` becomes
   `ldap-rest-monorepo`, private and workspace-only. This removes the split
   between "the repository root" and "a package": every published artefact
   lives under `packages/`. Do it once the extraction is over, before or with
   the first published plugin package, so the root never ships as a package
   by accident.

## First actions

Phases 0 to 2 are done, and phase 3 has removed the former plugin sub-paths:
the workspaces hold the core, the plugin packages, `browser` and `schemas`,
and `src/pluginModules.json` maps each `core/…` name to its package. What
remains:

1. Complete the contracts and the review ruleset ([#549] part 2).
2. Publish the scoped packages and write the `3.0.0` upgrade note and
   CHANGELOG entry.
3. Split `@ldap-rest/storage` per backend ([#651]).
4. Move the umbrella to `packages/ldap-rest/` (decision 8) and close [#397].

[#397]: https://github.com/linagora/ldap-rest/issues/397
[#549]: https://github.com/linagora/ldap-rest/issues/549
[#593]: https://github.com/linagora/ldap-rest/issues/593
[#594]: https://github.com/linagora/ldap-rest/issues/594
[#595]: https://github.com/linagora/ldap-rest/issues/595
[#603]: https://github.com/linagora/ldap-rest/issues/603
[#651]: https://github.com/linagora/ldap-rest/issues/651
