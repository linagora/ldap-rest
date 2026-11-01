# Plugin services

A plugin sometimes needs what another plugin holds: the group operations, the
entity schemas, the trash. A service is a typed interface a plugin provides
under a token, and another plugin reaches with `this.service(token)`.

The token carries the interface. The compiler checks that an instance bound
with `with()` answers it, and gives a consumer the type it declared. Whether a
provider exists is a runtime question: a plugin that stops declaring the token
still compiles, and its consumers get `null` and a warning. The plugin
registry name stays what it is for: loading a plugin and naming it in the
logs.

## Declaring a service

Put the token and its interface in a module both sides import — a plugin
family's own service in its own module. A service shared between families is
declared in `src/lib/services/` and re-exported from `ldap-rest/plugin`, one
of the package's entry points; a module under `src/lib/` has no export path of
its own.

```typescript
import { serviceToken } from 'ldap-rest/plugin';

export interface GroupsApi {
  listGroups(): Promise<string[]>;
}

export const GroupsService = serviceToken<GroupsApi>('groups');
```

Declare a token once. The object is the registry key; calling `serviceToken`
again under the same name declares another service, not the same one. The name
only identifies it in the logs.

## Providing a service

Bind the plugin instance to each token it provides:

```typescript
import DmPlugin from 'ldap-rest/plugin';

export default class LdapGroups extends DmPlugin {
  name = 'ldapGroups';
  provides = [GroupsService.with(this)];

  async listGroups(): Promise<string[]> {
    /* … */
  }
}
```

`with(this)` is checked by the compiler: an instance that does not answer the
interface does not compile. A plugin can provide several services. A service
is registered once its plugin's registration completes — after `api()` and
the hooks — so a consumer loaded afterwards finds it, and a provider does not
find its own service there. A plugin needing another one declares it in
[`dependencies`](dependencies.md#explicit-dependencies) so that it loads
first.

The first provider to register wins. A second one offering the same token is
ignored and named in a warning: which one answered would otherwise depend on
load order. Loading the same module twice under two names gives two instances
but one module-level token, so the second instance cannot provide it either.

When a host registers a plugin after startup, its `assertComposition` runs
before the service is registered, so a provider does not find its own service
there; the configuration's plugins are all registered before their
`assertComposition` runs.

## Consuming a service

```typescript
const groups = this.service(GroupsService);
if (!groups) {
  // Nothing provides it: the plugin skips the feature it would serve
  return;
}
await groups.listGroups();
```

`service()` answers the provided instance, or `null` when nothing provides the
token. It logs one warning per plugin and service rather than one per call. A
plugin that cannot work without a service declares the provider in
`dependencies`, checks the answer in `assertComposition`, and throws naming the
service — that stops the server at startup instead of leaving a feature
silently absent. A constructor runs before the dependencies load, so it cannot
be the place for that check.

The registry belongs to the server and is shared by the views `withConfig`
builds for plugins loaded with overrides. It has no removal: a plugin
registers once and keeps its services for the life of the server.

`this.requirePlugin(name)` remains for a plugin whose interface is not yet
declared as a service; new code reaches another plugin through a token.
