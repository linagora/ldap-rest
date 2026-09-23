# Storage Plugin

Keyed storage for whoever needs to keep something with a deadline.

## Overview

`core/storage` gives other plugins a key, a value and an instant past which
the value stops being returned. It knows nothing about why a record exists:
Back-Channel Logout tombstones were the first use, a refresh-token lock and a
shared counter are the ones in sight.

One plugin, one backend, named by `--storage-backend`. Consumers ask this one
for its store and work through a single interface; where the records actually
live is a deployment decision, not theirs.

Having exactly one is the point. The alternative — each consumer loading the
backend it likes — puts the same record in two places, and makes whichever
plugin was registered first decide what happens when one of them is unwell.
Loading a second instance is refused rather than left to registration order,
which is invisible in a configuration.

## Configuration

```bash
--plugin core/storage --storage-backend ldap \
  --storage-ldap-base ou=Records,dc=example,dc=com
```

| Option                        | Environment                    | Default              | Description                                               |
| ----------------------------- | ------------------------------ | -------------------- | --------------------------------------------------------- |
| `--storage-backend`           | `DM_STORAGE_BACKEND`           | _(none)_             | `ldap` or `file`. Empty means the plugin refuses to start |
| `--storage-sweep-interval`    | `DM_STORAGE_SWEEP_INTERVAL`    | `600`                | Seconds between two passes dropping expired records       |
| `--storage-ldap-base`         | `DM_STORAGE_LDAP_BASE`         | _(none)_             | Branch the `ldap` backend writes to                       |
| `--storage-ldap-object-class` | `DM_STORAGE_LDAP_OBJECT_CLASS` | `applicationProcess` | Object class of the entries it writes                     |
| `--storage-file-directory`    | `DM_STORAGE_FILE_DIRECTORY`    | _(none)_             | Directory the `file` backend writes to                    |

## Backends

### `ldap`

One entry per record under `--storage-ldap-base`. The branch holds records
and nothing else, so it belongs outside the branches the directory serves —
the plugin does not create it, and will not write into a branch that is not
there.

Suited to a deployment that already replicates its directory and wants the
records to follow, and to one where no other store is available.

### `file`

One file per record under `--storage-file-directory`. A write goes to a
temporary file and is renamed into place, so a reader never sees half a
record; the directory and its files are created `0700` and `0600`.

The directory is the plugin's own: nothing else should be writing there, and
the sweeper removes what it finds expired. It is local to one process, so it
suits a single instance, not a cluster sharing one verdict.

## Expiry

Two rules the backends do not get to reinterpret:

- **Expiry is enforced on read.** A record past its deadline is answered as
  absent whatever the sweeper has done, so a sweeper running late is a
  storage cost, never a wrong answer.
- **The deadline belongs to the consumer.** How long a record lives is the
  policy of whoever wrote it. The store is told an instant and respects it.

Keys are namespaced per consumer, so two of them cannot collide in one branch
or one directory.

## For Plugin Authors

```ts
const storage = this.requirePlugin<Storage>('storage');
await storage.store.set('myplugin', key, value, Date.now() + 3600_000);
const kept = await storage.store.get('myplugin', key); // null once expired
await storage.store.delete('myplugin', key);
```

`requirePlugin` warns and answers `null` when storage is absent, which is
right for a feature that can be skipped. A plugin making a **security**
decision must not read "no storage" as "nothing to check": it refuses to load
instead, as [Back-Channel Logout](../auth/back-channel-logout.md) does.

## See Also

- [Back-Channel Logout](../auth/back-channel-logout.md) — the first consumer
- [OpenID Connect](../auth/oidc.md)
