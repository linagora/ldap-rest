# AGENTS.md

Read this first. Follow it exactly. Skipping steps will break CI,
block merges, corrupt the codebase or make the maintainers unhappy.

## Presentation

- LDAP-Rest is a light directory manager: a REST API in front of an
  LDAP directory.

- The server is written in TypeScript. Features are plugins extending
  `DmPlugin`, communicating through hooks.

- The build is based on Rollup. `rollup.config.mjs` generates the
  `exports` field of `package.json`: never edit it by hand.

- Test with `npm run test:dev`, or `npm run test:one <files>`.

## Code comments

- Comment only unconventional or tricky code: a non-obvious
  constraint, a workaround, a subtle ordering, a security-relevant
  detail.
- Never paraphrase the code. If the comment restates what the next
  lines do, delete it.
- No project history in comments: no "used to", "since 0.6", "replaced
  the old check". Exception: rare cases where the history is required
  to understand why the implementation looks the way it does.
- No design rationale in build files, scripts or config files. Link
  to the relevant documentation instead, if anything.
- When you change code, update or remove the comments around it. An
  obsolete comment is worse than no comment: it misleads reviewers,
  auditors and agents.

## Documentation

- Document architecture choices and feature implementation once, in
  concise Markdown, in the `docs` folder.
- Record significant decisions in a single place; do not duplicate
  them in comments, changelog or commits.
- Elsewhere, reference that document rather than repeating its content.
- Command line options are documented in
  `docs/usage/configuration.md`.

## Specific files

### CHANGELOG.md

- Audience: administrators operating LDAP-Rest.
- List user-visible changes only: new features, behaviour changes,
  removals, fixes, security notes.
- The `Unreleased` section describes the difference with the last
  release, not the intermediate steps taken during development.
  Rewrite entries rather than appending corrections.
- Released sections are never modified.
- Keep entries short; link to the documentation for details.

### docs/usage/upgrading.md

- Audience: administrators upgrading between released versions.
- State only the actions required and their observable effects.

## Git commit messages

- Audience: developers.
- A concise subject line, then a short body explaining why when it is
  not obvious. Not a diary, not a copy of the documentation.
- Reference issues/PRs here — this is where history belongs.

## Before submitting

- [ ] Every comment explains something non-obvious and still true.
- [ ] No history, issue numbers or rationale in comments or build
      files.
- [ ] Design changes are documented once, in `docs`.
- [ ] CHANGELOG entries are written for administrators and reflect the
      current state.
- [ ] Commit messages are concise and explain why.
