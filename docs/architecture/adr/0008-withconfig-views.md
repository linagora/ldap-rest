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
{ config })`. The own properties that hold objects — the app, the hooks, the
LDAP actions, the plugin registry, the authenticators — are shared by
reference. The configuration is `{ ...this.config, ...overrides }`, a shallow
copy: overridden top-level keys are the plugin's alone, nested objects and
arrays are still shared with the server. The loader constructs a plugin with
overrides on such a view.

A primitive field would be copied by value into every view, so state the views
must share lives in an object: the operation counter (`_operations`, read
through the `operationSequence` accessor) and the composition flag
(`_compositionState`), as the dispatcher's own state does (`_authState`). A
view created while the plugins load therefore sees the composition once the
server has checked it.

The copy is built on the prototype rather than by spreading `{...this}`,
which copies own properties and leaves the methods behind: a plugin calling
`this.server.anything()` would throw, and only when configured with
overrides.

## Consequences

- A plugin loaded with overrides cannot change the server's configuration for
  anyone else; mutating `this.config` affects its view alone, at the top
  level.
- Primitive fields are copied by value, not shared: what must be shared is
  held in an object, as the operation counter and the composition flag are.
  A plugin registered after `ready` through a view created while loading is
  therefore checked against the composition like any other (before [#625] and
  [#626], the counter and the flag were primitives, and neither held).
- An own property added to the server after the view was created is not
  visible to that view. State that must be shared has to live in an object
  that already exists when the view is made.
- A plugin that closes over `this.server` keeps the view for its lifetime,
  which is the point: its options stay its own.
- Tests may call `withConfig` to exercise option-dependent behaviour without
  building a second server.

See `packages/core/src/bin/index.ts` (`withConfig`, `importPlugin`) and
[plugin options](../../plugin-development/options.md).

[#625]: https://github.com/linagora/ldap-rest/issues/625
[#626]: https://github.com/linagora/ldap-rest/issues/626
