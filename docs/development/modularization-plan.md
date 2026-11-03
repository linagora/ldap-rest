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
internal split. [#593], [#594], [#595] and [#603] are done.

## What blocks #397 today

`@ldap-rest/core` is a package of its own. What remains is extracting the
plugin families and the umbrella:

- The plugin families still live in the umbrella's `src/plugins/`, and the
  single package generates 88 `./plugin-*` exports from `rollup.config.mjs`.
- The umbrella composes the options in `src/options.ts` and passes them to the
  core `DM`; the core itself imports no family.

Between plugin families the only coupling left is
`TwakeGroups extends LdapGroups`.

## Target architecture

An npm workspaces monorepo with one package per plugin and an umbrella that
preserves the public API. Today's `./plugin-*` entries already separate the
plugins:

```text
packages/
  core/                   @ldap-rest/core
  ldap-externalusers/     @ldap-rest/ldap-externalusers
  ldap-groups/            @ldap-rest/ldap-groups
  ldap-organizations/     @ldap-rest/ldap-organizations
  auth-token/             @ldap-rest/auth-token
  twake-james/            @ldap-rest/twake-james
  twake-appaccounts/      @ldap-rest/twake-appaccounts
  scim/                   @ldap-rest/scim
  browser/                @ldap-rest/browser
  schemas/                @ldap-rest/schemas
  ldap-rest/              umbrella package (main CLI and re-exports)
```

The list is illustrative: the package name follows the plugin's feature name,
and each package may expose more than one entry point when the plugin already
has several (`twake-appaccounts` keeps its API and consistency classes
together, `scim` its modules).

Rules:

- `core` depends on no plugin; a plugin package depends on no other plugin
  package. Cross-plugin needs go through services
  (`packages/core/src/lib/services`) or hooks.
- `TwakeGroups extends LdapGroups` is either the one documented exception or
  the shared base moves to `core`.
- `ldap-rest` stays the entry package: it depends on every plugin package,
  keeps the `ldap-rest` CLI and the `core/…` namespace, and re-exports the
  former sub-paths (`ldap-rest/plugin-auth-authzlinid1`, …). The split is
  therefore not breaking for users.
- A plugin package ships the commands that belong to its feature:
  `@ldap-rest/ldap-externalusers` owns `cleanup-external-users`,
  `@ldap-rest/twake-james` owns `sync-james`, and
  `@ldap-rest/twake-appaccounts` owns `sync-app-accounts`. npm installs the
  `bin` of a dependency, so installing `ldap-rest` keeps every command.
- A script that needs a `DM` uses `@ldap-rest/core` and its own option set, not
  the umbrella or another plugin package: a plugin package cannot depend on
  `ldap-rest` without a cycle. `ldapActions`, the parser and the services are
  core, so using them loads no plugin.
- Being a dependency of `ldap-rest` only installs a plugin package; it does not
  load the plugin. `DM` loads only the `--plugin` entries and the priority
  list, so `cleanup-external-users` in `ldap-externalusers` never loads the
  LDAP plugins (and there is no aggregate `@ldap-rest/ldap` package).
- The umbrella keeps only the main `ldap-rest` command, the option composition
  and the `DM` subclass that supplies the plugin tree.
- The core parser accepts an injected `OptionSet`; the umbrella composes the
  option sets of every plugin. `Config` may stay a type-only aggregate in
  `core`, but runtime option imports leave the core.
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
   and per-package builds.
2. (**done**) Extract `@ldap-rest/core`, with the `ldap-rest` umbrella depending
   on it and re-exporting the existing entry points. `ConfigTemplate` and
   `ConfigEntry` are exported from the core; the umbrella re-exports the whole
   core API. The core is bundled in the umbrella tarball until phase 3
   publishes the scoped packages.
3. Extract one package per plugin, grouped for the order: storage → auth →
   ldap → scim → twake → misc.
4. Extract `browser` and `schemas`.
5. After each step: `npm run test:dev`, `npm run check`,
   `npm run check:openapi`, `npm run check:options`, and the `contracts` job.
6. Update the Dockerfile, the `bin/` scripts, the examples and the docs.

Outcome: a modular repository, with `ldap-rest` still installable and
compatible.

### Phase 3 — Contracts and finalization

1. [#595], part 2: one api-extractor report per sub-path, including the
   `./plugin-*` entries, and non-additive diffs refused by `contracts`.
2. [#549], part 2: the modularization decision record, a shrinking comment
   baseline, and the `require_code_owner_review` ruleset.
3. Publish the scoped packages and document the deprecation policy for the
   former sub-paths.
4. Close [#397].

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
2. **Versioning** (**decided**): 3.0.0 with the former sub-paths removed, on
   the `v3.0` branch.
3. **`TwakeGroups extends LdapGroups`**: documented exception, or move the
   shared base into `core`?
4. **`Config` type**: type-only aggregate in `core` (recommended to start), or
   split per package with declaration merging?
5. **Build**: Rollup per package (consistent with today) or `tsc` with
   generated exports?

## First actions

Phases 0 and 1 are done, and phase 2 has started with the workspaces and the
core package. The next steps are:

1. Extract the plugin packages in dependency order, then `browser` and
   `schemas`.
2. Finish [#549] part 2 in phase 3.

[#397]: https://github.com/linagora/ldap-rest/issues/397
[#549]: https://github.com/linagora/ldap-rest/issues/549
[#593]: https://github.com/linagora/ldap-rest/issues/593
[#594]: https://github.com/linagora/ldap-rest/issues/594
[#595]: https://github.com/linagora/ldap-rest/issues/595
[#603]: https://github.com/linagora/ldap-rest/issues/603
