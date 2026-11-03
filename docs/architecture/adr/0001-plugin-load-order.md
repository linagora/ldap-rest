# 0001 — Plugin load order

## Context

Plugins are listed with `--plugin`, in the order the administrator writes
them, and a plugin may declare `dependencies` naming modules that must be
registered before it. Some plugins cannot simply be imported in parallel with
the rest: a guard whose Express middleware must sit ahead of the routes it
protects, an access log that must see every request, an authenticator or URL
gate other plugins must find registered when they register. Import order in
the parallel batch is the order the imports happen to complete, which is not a
configuration.

## Decision

`src/config/priority.json` lists the modules loaded first. That pass is
sequential, in the file's order, and every instance of a priority module is
loaded there, in configuration order — matching is on the module, not on the
whole `--plugin` entry, so a named instance (`module:name:{…}`) keeps its
rank. The remaining entries load in parallel. A declared dependency is loaded
on demand when the plugin that needs it registers. A module requested twice
under the same name without overrides is loaded once; a second instance needs
its own name. Two plugins with the same instance name are refused, and the
second is dropped with a warning. `configApi` loads last.

The list holds four kinds of plugin: the guards whose middleware must run
before the routes (`trustedProxy`, `crowdsec`, `rateLimit`), the access log
that must see every request (`weblogs`), the authenticators the dispatcher and
the authorization plugins naming them have to find registered (`token`,
`fake`, `llng`, `openidconnect`), and the URL gate whose rules must exist
before the routes they judge (`authzPerRoute`). `core/storage` is there
because others must find it registered when they register.

Hooks run in load order, except the request hooks of authorization plugins,
which run before every other subscriber's.

## Consequences

- A plugin whose middleware must precede routes has to be in
  `priority.json`; being written first in the configuration is not enough
  once the parallel batch starts.
- The relative order of two plugins that are neither priority nor linked by a
  dependency is not defined, and no plugin may rely on it.
- Adding a module to the priority list changes the order for every
  deployment, so the list stays short.
- An instance named with overrides loads at the rank of its module but keeps
  its own configuration through a [server view](0008-withconfig-views.md).

See [dependencies](../../plugin-development/dependencies.md) and
`src/bin/index.ts`.
