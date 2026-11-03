# 0004 — Fail-closed request context

## Context

An authorization judge decides from the request (`req.user`, its
authenticators, its path). But a directory operation is often made deep in a
plugin that never received the request: a provisioning step incremented from a
hook, a consistency repair, a route helper that searches before it writes.
Passing the request down every call is easy to forget, and a forgotten request
used to mean an operation nobody judged — a hole that is invisible until
someone writes through it.

## Decision

The authentication dispatcher runs everything downstream of an authenticated
request inside `runForRequest(req, next)`, an `AsyncLocalStorage`. Every
directory operation defaults to `currentRequest()`, so a plugin that forgets
the request still gets the caller's identity and is judged as them. Operations
the server makes for itself run inside `outsideRequest()`, which `ldap.system`
uses: it is the explicit escape from judgement, not a default.

The log context is a second `AsyncLocalStorage`, kept apart: a line written as
the server, outside the request, still names the request that made the server
act. `outsideAnyRequest()` leaves both, for work that outlives a request (a
pooled connection, a process-wide client).

Hooks are the one place that deliberately leaves the context: the bus runs
every subscriber inside `outsideRequest()`, so a hook's own writes are the
server's and not the caller's. A hook that judges or acts for the caller has
the request in its arguments and names it.

## Consequences

- A plugin that means to act as the server must say so with `ldap.system`;
  forgetting the request fails closed instead of opening a hole.
- A test that calls a plugin's directory operations directly must wrap them in
  `runForRequest` to reproduce what the server does, or get the unjudged
  behaviour of `ldap.system`.
- Asynchronous work started inside the request inherits it, so a background
  task that should not act as the caller has to leave the context first.
- Errors and logging inherit the request id, which makes a write traceable to
  the request that caused it.

See `packages/core/src/lib/requestContext.ts` and `packages/core/src/lib/ldapActions.ts`
(`forRequest`, `system`, `currentRequest`).
