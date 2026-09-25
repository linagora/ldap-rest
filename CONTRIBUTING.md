# Contributing to LDAP-Rest

The rules on comments, documentation, changelog and commit messages are in
[AGENTS.md](./AGENTS.md); they apply to humans too.

## Getting started

Prerequisites: Node.js 20+, Docker (the test suite starts its own LDAP
server).

```bash
git clone https://github.com/linagora/ldap-rest.git
cd ldap-rest
npm install
npm run build:dev
```

To run the server with every plugin loaded, point it to a directory first,
with a `~/.test-env` file such as:

```bash
export DM_LDAP_URL="ldap://localhost:389"
export DM_LDAP_DN="cn=admin,dc=example,dc=com"
export DM_LDAP_PWD="admin"
export DM_LDAP_BASE="dc=example,dc=com"
export DM_LDAP_TOP_ORGANIZATION="ou=organization,dc=example,dc=com"
```

```bash
source ~/.test-env && npm run start:dev
```

## Where to read next

- [Plugin development](./docs/plugin-development/README.md): architecture,
  plugins, [hooks](./docs/plugin-development/hooks.md),
  [testing](./docs/plugin-development/testing.md)
- [Configuration](./docs/usage/configuration.md): options and environment
  variables
- [Client development](./docs/client-development/README.md): REST API,
  browser libraries, schemas

## Checks

```bash
npm run test:dev                  # build, then the whole suite
npm run test:one test/foo.test.ts # a subset
npm run check                     # types, ESLint, Prettier, no client values
npm run fix                       # ESLint and Prettier fixes
```

Without `DM_LDAP_*` variables, the tests run against an embedded LDAP server
in Docker; `source ~/.test-env` first to use yours.

### Coverage

CI runs `npm run coverage:check`: the suite, once, failing below the
thresholds set in `package.json`. They sit a few points under the measured
values to catch drift; when they fail, the fix is usually a missing test, not
a lower threshold. Raise them when the real figure moves up.

The gate excludes `src/browser`, which the suite cannot exercise without a
DOM, and the type-only files listed in `.c8rc.json`. `npm run coverage` still
reports everything in `coverage/index.html`.

## Submitting changes

1. Branch from `master`: `feat/<topic>` or `fix/<topic>`.
2. Add tests: a fix comes with a test that fails without it.
3. Commit following [Conventional Commits](https://www.conventionalcommits.org/):
   `fix(authz): …`, `docs(upgrading): …`.
4. Open a pull request on GitHub.

## License

By contributing to LDAP-Rest, you agree that your contributions will be
licensed under the [AGPL-3.0 License](./LICENSE).
