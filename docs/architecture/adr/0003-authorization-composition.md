# 0003 — Authorization composition

## Context

Every plugin that judges directory operations registers the same request
hooks (`ldapsearchrequest`, `ldapaddrequest`, `ldapmodifyrequest`,
`ldapdeleterequest`, `ldaprenamerequest`). Chained hooks run every subscriber
and the first refusal wins, so two loaded authorization plugins compose as an
AND. That rule is sound when it is meant. It is a refusal nobody can explain
when it is not: `authzPerBranch` next to `authzDynamic` judges a machine token
by a branch configuration written for administrators and refuses a write the
token's ACLs grant.

## Decision

A plugin with the `authz` role that registers LDAP hooks is a _judge_. It
judges the requests authenticated by the plugins named in `--authz-for`, or
everyone by default. A plugin that authenticates as well judges only its own
requests: its hooks read the credential it verified.

`assertAuthzComposition` runs once every configured plugin is loaded, and
again for each plugin registered later. It refuses:

- an `--authz-for` naming no loaded authentication plugin;
- two judges whose populations can share a request, unless `--authz-combine`
  makes the AND deliberate.

Two judges whose authenticators run on the same prefix are reported, not
refused: asking for two credentials is already a decision. A judge on
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
- Judges run first, and all of them run: the first refusal answers, so the
  order matters and is the load order of the judges.
- A judge that also authenticates judges only its own requests; a request it
  did not vouch for passes its hooks untouched, because the absence of its
  credential is not a refusal it makes.

See `src/lib/authz/composition.ts` and `src/config/args.ts`.
