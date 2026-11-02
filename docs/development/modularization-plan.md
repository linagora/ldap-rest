# Modularization plan

How the remaining architecture work is sequenced: [#397] and the five
`code-quality` issues that depend on it or prepare it. The plan is a roadmap,
not a contract; update it as the work lands.

## Open issues

| Issue  | Subject                                                                             | Role                          | Size   |
| ------ | ----------------------------------------------------------------------------------- | ----------------------------- | ------ |
| [#397] | Split the repository into `@ldap-rest/*` modules                                    | Final step                    | Major  |
| [#593] | Finish the plugin service migration: entity registry, call sites, family boundaries | Prerequisite of #397          | Large  |
| [#594] | Finish the `ldapActions` split: operation pipeline and façade                       | Prerequisite of #397          | Medium |
| [#595] | Snapshot the plugin API types and gate changes                                      | Safety net, start before #397 | Medium |
| [#549] | Architecture pages, decision records, comment check                                 | Independent, start early      | Medium |
| [#603] | Enable the type-checked ESLint rules the test block leaves out                      | Independent, quick win        | Small  |

[#397] is still in the `2.0.0` milestone, which is released. Retarget it to a
2.x epic or to 3.0.0 once the compatibility decision below is made. [#593] and
[#594] are labelled `Minor`/`backlog` but are the real prerequisites of
[#397]; promote them to the same milestone.

## What blocks #397 today

The core still imports plugin code:

- `src/config/args.ts` imports the option sets of every plugin family.
- `src/bin/index.ts` imports `src/plugins/priority.json`.
- `src/hooks.ts` imports `ChangesToNotify` from
  `src/plugins/ldap/onChange.ts` and the SCIM types from
  `src/plugins/scim/types.ts`.
- `src/abstract/ldapFlat.ts` reads `server.loadedPlugins` and uses
  `requirePlugin`.
- `src/lib/ldapActions.ts` is 1,375 lines; `src/lib/ldap/operations.ts` does
  not exist.
- The single package generates 66 `./plugin-*` exports from
  `rollup.config.mjs`, with no npm workspaces.

Between plugin families the coupling is smaller: only the Twake plugins import
`ldap`/`scim` (15 imports), plus `TwakeGroups extends LdapGroups`.

## Target architecture

An npm workspaces monorepo with an umbrella package that preserves the public
API:

```text
packages/
  core/                 @ldap-rest/core
  plugin-auth/          @ldap-rest/plugin-auth
  plugin-ldap/          @ldap-rest/plugin-ldap
  plugin-scim/          @ldap-rest/plugin-scim
  plugin-storage/       @ldap-rest/plugin-storage
  plugin-twake/         @ldap-rest/plugin-twake
  plugin-misc/          @ldap-rest/plugin-misc
  browser/              @ldap-rest/browser
  schemas/              @ldap-rest/schemas
  ldap-rest/            umbrella package (CLI and re-exports)
```

Rules:

- `core` depends on no family; a family depends on no other family. Cross-family
  needs go through services (`src/lib/services`) or hooks.
- `TwakeGroups extends LdapGroups` is either the one documented exception or
  the shared base moves to `core`.
- `ldap-rest` stays the entry package: it depends on every package, keeps the
  CLI and the `core/…` namespace, and re-exports the former sub-paths
  (`ldap-rest/plugin-auth-authzlinid1`, …). The split is therefore not breaking
  for users.
- The core parser accepts an injected `OptionSet`; the umbrella composes the
  option sets of every family. `Config` may stay a type-only aggregate in
  `core`, but runtime option imports leave the core.
- Each package builds on its own with a shared configuration; the umbrella
  re-exports. The Twake-specific `bin/` scripts move to their package or to a
  `@ldap-rest/cli` package.

A package per plugin (`@ldap-rest/authz-linid1`, …) is possible, but start with
families and extract optional plugins individually later. Otherwise the first
day costs 66 packages and 66 release cycles.

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
     types out of `plugins/scim/` into `src/lib/`;
   - ESLint: forbid `loadedPlugins` under `src/plugins/**` and imports between
     plugin families.
2. [#594]: extract the operation pipeline into `src/lib/ldap/operations.ts`,
   bring `ldapActions.ts` under 400 lines, add the file-size test, move the
   ESLint exemption, add the type test on `ldap-rest/ldapactions`.
3. Options refactor (needs its own issue): split `src/config/args.ts` into core
   options and per-family option sets; let the parser/`DM` accept an
   `OptionSet`; move `priority.json` into the core or make it a parameter.

Outcome: `src/hooks.ts` imports no plugin, the core reads no `loadedPlugins`,
families do not import each other, and `ldapActions` is a stable façade.

### Phase 2 — Workspaces and extraction

1. Set up npm workspaces, `packages/`, a shared `tsconfig` and per-package
   builds.
2. Extract `@ldap-rest/core` first, with the `ldap-rest` umbrella depending on
   it and re-exporting the existing entry points.
3. Extract the families in dependency order: storage → auth → ldap → scim →
   twake → misc.
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

1. **Granularity**: packages per family (recommended) or one package per plugin
   from the start?
2. **Versioning**: a non-breaking internal split in 2.x with the umbrella
   (recommended), or 3.0.0 with the former sub-paths removed?
3. **`TwakeGroups extends LdapGroups`**: documented exception, or move the
   shared base into `core`?
4. **`Config` type**: type-only aggregate in `core` (recommended to start), or
   split per package with declaration merging?
5. **Build**: Rollup per package (consistent with today) or `tsc` with
   generated exports?

## First actions

1. Retarget [#397] and add the package map and the dependency rule to it.
2. Open sub-issues for [#593] and [#594]; both are too large for one pull
   request.
3. Start [#603] and [#549] part 1 in parallel.
4. Spike [#595] on the five main entry points.
5. Then [#593]/[#594], then the package extraction.

[#397]: https://github.com/linagora/ldap-rest/issues/397
[#549]: https://github.com/linagora/ldap-rest/issues/549
[#593]: https://github.com/linagora/ldap-rest/issues/593
[#594]: https://github.com/linagora/ldap-rest/issues/594
[#595]: https://github.com/linagora/ldap-rest/issues/595
[#603]: https://github.com/linagora/ldap-rest/issues/603
