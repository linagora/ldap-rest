# 0008 — Server views for plugins with overrides

## Context

The same plugin module can be loaded several times with different settings:
`--plugin 'core/auth/token:admins:{…}'` and
`--plugin 'core/auth/token:users:{…}'`. The plugin constructor receives the
server, and reads its options from `this.server.config` and `this.config`.
Those instances must see their own configuration while acting on the one
server: the same Express app, the same hooks, the same LDAP connection and
the same plugin registry. A second `DM` would be a second server.

## Decision

`DM.withConfig(config)` returns a view of the server built with
`Object.create(Object.getPrototypeOf(this))` and `Object.assign(…, this,
{ config })`. Own properties — the app, hooks, LDAP actions, plugin registry,
operation sequence — are shared by reference; only `config` differs. The
loader constructs a plugin with overrides on such a view.

The copy is built on the prototype rather than by spreading `{...this}`,
which copies own properties and leaves the methods behind: a plugin calling
`this.server.anything()` would throw, and only when configured with
overrides.

## Consequences

- A plugin loaded with overrides cannot change the server's configuration for
  anyone else; mutating `this.config` affects its view alone.
- State added to the server after the view was created is still shared if it
  lives in an own property; a new field holding mutable state has to be an
  object, not a primitive, for the views to see its changes.
- A plugin that closes over `this.server` keeps the view for its lifetime,
  which is the point: its options stay its own.
- Tests may call `withConfig` to exercise option-dependent behaviour without
  building a second server.

See `src/bin/index.ts` (`withConfig`, `importPlugin`) and
[plugin options](../../plugin-development/options.md).
