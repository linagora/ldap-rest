# Plugin services

A plugin sometimes needs what another plugin holds: the group operations, the
entity schemas, the trash. A service is a typed interface a plugin provides
under a token, and another plugin reaches with `this.service(token)`.

The token carries the interface. The compiler checks that the provider answers
it and that the consumer reads it, so a renamed plugin or a changed shape
fails at build time rather than silently skipping work at runtime. The plugin
registry name stays what it is for: loading a plugin and naming it in the
logs.

## Declaring a service

Put the token and its interface in a module both sides import — a core service
in `src/lib/services/`, a plugin family's own service in its own module.

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

`with(this)` refuses an instance that does not answer the interface. A plugin
can provide several services. A service is registered once its plugin's
registration completes, so a consumer loaded afterwards finds it; a plugin
needing another one declares it in [`dependencies`](dependencies.md#explicit-dependencies)
so that it loads first.

The first provider to register wins. A second one offering the same token is
ignored and named in a startup warning: which one answered would otherwise
depend on load order.

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
