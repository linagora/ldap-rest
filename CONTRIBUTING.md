# Contributing to LDAP-Rest

The rules on comments, documentation, changelog and commit messages are in
[AGENTS.md](./AGENTS.md); they apply to humans too.

## Getting started

Prerequisites: Node.js 22+, Docker (the test suite starts its own LDAP
server).

```bash
git clone https://github.com/linagora/ldap-rest.git
cd ldap-rest
npm install
npm run build:dev
```

To run the server with every plugin loaded, point it to a directory first:

```bash
export DM_LDAP_URL="ldap://localhost:389"
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="admin"
export DM_LDAP_BASE="dc=example,dc=com"
export DM_LDAP_TOP_ORGANIZATION="ou=organization,dc=example,dc=com"
npm run start:dev
```

## Where to read next

- [Plugin development](./docs/plugin-development/README.md): architecture,
  plugins, [hooks](./docs/plugin-development/hooks.md),
  [testing](./docs/plugin-development/testing.md)
- [Configuration](./docs/usage/configuration.md): options and environment
  variables
- [Client development](./docs/client-development/README.md): REST API,
  browser libraries, schemas

## Tests and checks

```bash
npm run test:dev                  # build, then the whole suite
npm run test:one test/foo.test.ts # a subset
npm run check                     # types, ESLint, Prettier, no client values
npm run check:ts                  # types, with the TypeScript 5 compiler
npm run check:ts7                 # types, with TypeScript 7
npm run fix                       # ESLint and Prettier fixes
```

CI runs both type checks, and both are blocking: a change must type-check
under the `typescript` 5 line that the build loads and under the
`typescript7` npm alias of the stable TypeScript 7 release. The two packages
both ship a `tsc` binary, so each script runs the package entry rather than
`node_modules/.bin/tsc`.

Without `DM_LDAP_*` variables, the tests run against an embedded LDAP server
in Docker; set them as above to use yours. How the embedded server works:
[testing](./docs/plugin-development/testing.md).

### Coverage

CI runs `npm run coverage:check`: the suite, once, failing below the
thresholds set in `package.json`. They sit a few points under the measured
values to catch drift; when they fail, the fix is usually a missing test, not
a lower threshold. Raise them when the real figure moves up.

The gate excludes `src/browser`, which the suite cannot exercise without a
DOM, and the type-only files listed in `.c8rc.json`. `npm run coverage` still
reports everything in `coverage/index.html`.

### Dependencies

Dependabot opens the updates (`.github/dependabot.yml`), grouped for npm.
`npm run audit:prod`, run by CI, fails on a `high` or `critical` advisory in a
production dependency, and on an entry of `.github/audit-allowlist.json`
that is past its day or matches no advisory. An allowlist entry names a
package or a GHSA id (`npm audit` gives no CVE), `until`, the last day (UTC)
it applies, and `reason`. An advisory named by its GHSA covers the packages
that pull the vulnerable one in as well. Fix the advisory; allow it only
where it cannot apply here, and remove the entry once it is fixed.

A pull request gets the same gate from GitHub's dependency review, configured
in `.github/dependency-review-config.yml`. Its `allow-ghsas` list is the
equivalent of `.github/audit-allowlist.json`: add a GHSA only with a comment
saying why it cannot apply, and remove it once the dependency is patched.

### Package overrides

`package.json` overrides raise the floor of a transitive dependency that no
released parent resolves to a patched version. Each one names the advisory
that keeps it there, and the path that pulls the package in:

| Override                         | Advisory                                                                                                            | Resolved through                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `diff >=8.0.3`                   | `GHSA-73rr-hh4g-fpgx` (low), denial of service in `parsePatch` and `applyPatch`                                     | `mocha`, test only                                       |
| `glob >=11.1.0`                  | `GHSA-5j98-mcp5-4vw2` (high), command injection through the CLI                                                     | build and test tools                                     |
| `minimatch ^10.2.3`              | `GHSA-3ppc-4f35-3m26`, `GHSA-7r86-cg39-jmmj` and `GHSA-23c5-xmqv-rm74` (high), regular-expression denial of service | build and test tools                                     |
| `postcss-selector-parser ^7.1.6` | `GHSA-rj75-hqrm-r3gf` (medium), quadratic selector parsing                                                          | `rollup-plugin-postcss`, build only                      |
| `serialize-javascript >=7.0.3`   | `GHSA-5c6j-r48x-rmvq` (high), remote code execution through `RegExp.flags`                                          | `@rollup/plugin-terser` and `mocha`, build and test only |

To check one: remove it, run `npm install`, then `npm ls <package>` and
`npm audit`. Keep it out when every resolved version is outside the
advisory's vulnerable range; otherwise put back the lowest floor that stays
patched. An override no dependency resolves any more is stale: remove it.

## Submitting changes

1. Branch from `master`: `feat/<topic>` or `fix/<topic>`.
2. Add tests: a fix comes with a test that fails without it.
3. Commit following [Conventional Commits](https://www.conventionalcommits.org/):
   `fix(authz): …`, `docs(upgrading): …`.
4. Open a pull request on GitHub, filling the template: it records the
   reviews below.

## Reviewing changes

Every pull request gets two independent reviews from distinct AI assistants,
in addition to the author's own reading. They look for correctness bugs,
security issues, missing tests and drift from [AGENTS.md](./AGENTS.md). Their
findings are discussed in the pull request, not applied silently.

They do not replace an owner. An assistant has no stake in the code,
does not arbitrate architectural decisions, and cannot take over a path when
its maintainer leaves. A change to a path listed in `.github/CODEOWNERS`
therefore still needs a human code owner's approval, from someone other than
the author.

The pull request records who performed which review. A merged change without
that record is a gap: fill it in the next pull request, and prefer a visible
review over an undocumented one.

## License

By contributing to LDAP-Rest, you agree that your contributions will be
licensed under the [AGPL-3.0 License](./LICENSE).
