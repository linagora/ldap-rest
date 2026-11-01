# Published contracts

Other code depends on three things ldap-rest publishes. A change to one that
is not additive breaks that code, so it needs a major release and the pull
request says so before it merges.

- **Configuration**: the CLI options and `DM_*` variables of
  [Configuration](../usage/configuration.md) and of each plugin's page.
- **REST API**: the routes, request bodies and answers of the
  [REST API](../client-development/api/rest-api.md), their parameters,
  responses (references resolved), statuses and response headers. The error
  `code` values are reviewed by hand: the document types them as strings.
- **Plugin API**: what the npm sub-path exports declare — `ldap-rest`,
  `./hooks`, `./plugin`, `./ldapactions`, `./expressformatedresponses`, the
  `./plugin-*`, `./abstract-*` and `./browser-*` entries — and the JSON
  schema format of the `./schema-*` entries.

[API stability](../README.md#api-stability) says what a minor or patch
release promises. This page says how a change is detected, and what to do
when it is not additive.

## Committed snapshots

Two snapshots are generated locally and checked in CI, so a change to a
contract shows up as a diff instead of a surprise after the release:

- `docs/usage/options.snapshot.json` lists every option's CLI name, plural
  form, environment variable, type, default, kind, required flag and aliases.
  Regenerate it with `npm run snapshot:options`; `npm run check:options`, part
  of `npm run check`, fails when it is stale.
- `openapi.json` is the REST API document the published reference is built
  from. Regenerate it with `npm run generate:openapi`; `npm run check:openapi`
  fails when it is stale.

The plugin types have no snapshot yet: one api-extractor report per sub-path
export is a change of its own. Until it lands, a change to an exported type is
reviewed by hand.

The snapshot records what the parser reads. A narrowed `choices` list, a
raised `min` or a lowered `max` is checked when a plugin reads its options,
not by the snapshot, and is reviewed by hand, as is a custom error `code`.

## The pull request gate

The `contracts` job of `.github/workflows/contracts.yml` generates the
snapshots from the pull request and compares them with the base branch's
committed ones. It reports:

- additive changes — a new option, route or field — and lets them through;
- non-additive changes, and fails unless the pull request carries the
  `breaking` label.

A change is non-additive when it removes or narrows what was published:
a removed option or environment variable, a changed type, default, bound,
`const`, enum or required flag, a request value that becomes an enum, a
request object that stops accepting additional properties, a removed route,
method, parameter, response status, response header or field, a request field
that becomes required, a response that may now be null, changed security
requirements, a removed union variant, a value an alternative of the type
closes with an enum or a `const` where the type used to accept any, an
untyped request value that becomes a union, an `allOf` that adds a
constraint, or — once the plugin snapshot exists — a removed export or a
narrowed signature. Renaming an option is a deprecation, not a removal, as
long as the old CLI name and environment variable stay in its `aliases` and
`envAliases`. Adding a union variant, a field or an optional parameter is
additive, and so is a request union with an alternative that still accepts
everything the base did — in a response the client reads every alternative,
so a field the others drop is still a removal. Documentation-only edits, such
as a summary or description, are ignored.

The job runs the scripts from the pull request, so a change to them is
reviewed like any other code, as `.github/CODEOWNERS` requires.

The `breaking` label records that the maintainers accepted the break, and the
`CHANGELOG.md` section must say so: the release gate below reads the section,
not the label, and refuses to ship the break as a minor or patch release. The
workflow listens to label events, so adding the label runs the job again; it
has its own concurrency group, so that event does not cancel the test matrix.

To try the comparison locally against your base branch:

```bash
npx tsx scripts/contracts.ts --base origin/master
```

## The release gate

`.github/workflows/release.yml` runs `scripts/check-release.ts` on the tag. A
non-major tag whose `CHANGELOG.md` section lists `### Breaking Changes` is
refused. For a 0.x version, a minor release counts as major, as semantic
versioning lets it break. When the tag has no section of its own, the gate
reads `## Unreleased`, so a tag cut before the section was renamed is still
checked; with neither section it fails. When the CHANGELOG lists no earlier
release, only a first `X.0.0` counts as major, so a trimmed file cannot open
the gate.

## Deprecating instead of breaking

The window and the rules are in
[CONTRIBUTING.md](../../CONTRIBUTING.md#deprecating-a-published-contract).
The mechanics of an option alias are in
[plugin options](../plugin-development/options.md#deprecating-an-option): the
old CLI name and environment variable go in `aliases` and `envAliases`, and
the server warns at startup while it still reads them. An array option's
plural form has no alias slot: renaming it is a breaking change, so it waits
for a major release.
