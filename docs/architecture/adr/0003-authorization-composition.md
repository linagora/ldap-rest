# 0003 — Authorization composition

## Context

Every plugin that judges directory operations registers the same request
hooks (`ldapsearchrequest`, `ldapaddrequest`, `ldapmodifyrequest`,
`ldapdeleterequest`, `ldaprenamerequest`). Chained hooks run their
subscribers in order and stop at the first refusal, so two loaded
authorization plugins compose as an AND: the first to refuse answers. That
rule is sound when it is meant. It is a refusal nobody can explain when it is
not: `authzPerBranch` next to `authzDynamic` judges a machine token by a
branch configuration written for administrators and refuses a write the
token's ACLs grant.

## Decision

A plugin with the `authz` role that registers LDAP hooks is a _judge_. It
judges the requests authenticated by the plugins named in `--authz-for`, or
everyone by default. A plugin that authenticates as well judges only its own
requests: its hooks read the credential it verified.

`assertAuthzComposition` runs once every configured plugin is loaded, and
again for each plugin registered later. It refuses:

- an `authz_for` naming a plugin that is not a loaded authenticator — the
  plugin would judge nobody. A server-wide `--authz-for` that no loaded plugin
  reads only warns, as does an `authz_for` on a plugin that also
  authenticates;
- two judges whose populations overlap on an authenticator — the same one, or
  one of them judging everyone — unless `--authz-combine` makes the AND
  deliberate.

Two judges whose authenticators can run on the same prefix, without sharing an
authenticator name, are reported, not refused: asking for two credentials is
already a decision, and a request carrying both is judged by both. A judge on
`authzPerRoute` gates URLs and registers no LDAP hook, so it is not part of
this AND — route plus branch is a documented combination.

The request hooks of judges run before every other plugin's request hook and
`ldapsearchfilter` keeps the load order. All the LDAP hooks compose as an
AND, including the filters: two filters narrow the result twice.

## Consequences

- A deployment with two branch models on the same population no longer starts
  unless it says `--authz-combine`; the error names both plugins.
- Naming authenticators in `--authz-for` requires stable instance names, so
  the configuration that scopes authentication and the one that scopes
  authorization must agree.
- A plugin registered by an embedding host is checked before its routes and
  hooks exist, so a refused plugin leaves nothing behind.
- Judges run first, in their load order. The chain stops at the first refusal,
  so a judge after a refusing one does not run; the refusal is the answer.
  No judge is skipped while the request is still allowed.
- A judge that also authenticates judges only its own requests; a request it
  did not vouch for passes its hooks untouched, because the absence of its
  credential is not a refusal it makes.

See `packages/core/src/lib/authz/composition.ts`, the `authz_for` and `authz_combine`
options in `packages/core/src/config/args.ts`, and `authz_scope_source` in
`packages/authz-scope/src/authzScope.options.ts`.
