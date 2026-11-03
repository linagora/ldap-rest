# 0002 — Authentication dispatch

## Context

One server can host populations that authenticate differently: administrators
behind a token, users behind OpenID Connect, machine clients behind HMAC. An
authentication plugin declares the path prefixes it claims. A request must run
the authentication that owns its path, and only that one: running two
unrelated authenticators on one request composes as an AND that no credential
can satisfy. A request no plugin claims must not silently become open without
saying so.

## Decision

`DM` mounts one dispatcher layer, once, at the boundary between the protection
plugins and the routes. For each request it selects the plugins whose prefix
is the longest match. Several plugins sharing that winning prefix all run, in
registration order, and every one must let the request through. When no
plugin claims the path, the unscoped plugins (no prefix) run; when there is
none, the request passes through unauthenticated, outside any request
context. A plugin's `afterChain` runs after the whole chain and before the
route. `runForRequest` then wraps everything downstream of a request an
authenticator let through, and the dispatcher records which plugins vouched
for the request in `req.authenticators`.

`warnUnauthenticatedRoutes` lists, at startup, the routes that no
authentication plugin covers. An unscoped authenticator guards everything and
silences the warning.

## Consequences

- Two authenticators on one prefix require both credentials. That is
  legitimate — a session and a token — but it fails closed when accidental.
- Scoping authentication to a prefix opens every route outside it; the
  startup warning is the only signal, and it names the routes.
- `afterChain` is the only hook that sees all the selected authenticators'
  verdicts, so an answer that depends on several of them belongs there, not
  in a plugin's own middleware.
- An authorization plugin can tell whose request it judges from
  `req.authenticators`; see
  [authorization composition](0003-authorization-composition.md).

See `packages/core/src/bin/index.ts` (`dispatchAuth`) and `packages/core/src/lib/auth/base.ts`.
