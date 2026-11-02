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

`this.requirePlugin(name)` remains for a third-party plugin whose target is
not yet declared as a service. A core plugin reaches another one through a
token, and ESLint refuses both `loadedPlugins` and `requirePlugin` under
`src/plugins/`.

## The entity registry

The server owns one registry of the entity types the loaded plugins serve:
flat entities, groups and organizations. A plugin declares its entities as it
loads, and a consumer reads them from `server.entities` or through
`EntityRegistryService` instead of indexing `server.loadedPlugins`:

```typescript
for (const entity of this.server.entities.ofKind('flat')) {
  const attribute = roleAttribute(entity.schema, 'domainName');
  if (attribute) branches.push({ base: entity.base, attribute });
}
```

A descriptor carries the singular and collection names, the branch, the main
attribute, the kind and the schema. The schema is read through the declaring
plugin, so a plugin that loads it asynchronously is still described once it
arrives. A flat descriptor also carries the write path (`flat.modifyEntry`),
for a plugin driving the entity.

`TwakeGroups` is the one exception: it extends `LdapGroups` but serves its own
API, so it overrides the declaration and does not register a `groups` entity.

## Services the server provides

The server itself provides `AuthenticatorsService`
(`server.authenticatorsInfo`): the loaded authentication plugins, whether one
is loaded, and the identities they can publish. It also provides
`PluginInfoService` (`server.pluginInfo`): whether a plugin is loaded, and the
plugins serving configuration, operational attributes, generated attributes
or authorization.

A plugin family provides the others:

- `TrashService`: the trash branch and the branches it watches.
- `PasswordPolicyService`: the branch holding the password policies.
- `RabbitMqService`: the shared broker, its publish, subscribe and
  reachability check.
- `StorageService`: the one keyed store and its backend.
- `TwakeGroupsService`: the groups of a Twake space, their branches and the
  pages the space routes read.
- `TombstoneService`: whether the Twake tombstone keeps a DN from a plain
  delete.
- `ScimService`: the lock attribute and value SCIM writes.
- `ReferenceRewriterService`: the references a rename must rewrite.

A consumer that only needs to know whether the feature is loaded calls
`this.service(token)` and skips its work when the answer is `null`. A file
under `src/plugins/` may not read `server.loadedPlugins`; ESLint refuses it.
