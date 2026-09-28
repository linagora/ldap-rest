# Lifecycle Events

`core/twake/lifecycleEvents` publishes an account's or a group's lifecycle to
RabbitMQ from the directory write itself. REST, SCIM and any other plugin writing through
LDAP-Rest announce the same events, with the same payloads.

Which entries are accounts or groups, which attributes carry the role, the
lock, the deletion and the members, and where each event goes are
configuration.

## Events

Each event is a change of state, read from the entry before and after a write
(`onLdapEntryChange`, from `core/ldap/onChange`). A write that changes nothing
publishes nothing.

- `created`: an entry is added. An entry added locked, as a SCIM create with
  `active: false` does, publishes `created` then `disabled`.
- `roleChanged`: the role attribute gets different values. Case and order are
  ignored: `Admin` and `admin` are one role. A multi-valued role attribute is
  compared as a set, but `$title` carries its first value only, so
  `[x, y]` to `[x, z]` publishes `x` as both role and previous role: keep the
  role in a single-valued attribute.
- `disabled`: the lock attribute takes the lock value.
- `enabled`: the lock attribute no longer holds the lock value.
- `updated`: a target whose payload has `$changed.` sources publishes when one
  of them changed, with those that did not left out. A target without them
  publishes on every change of the entry.
- `memberAdded`, `memberRemoved`: the member attribute gains or loses values.
  The old and new lists are compared as sets, so a whole list replaced
  publishes only the members that came or went. The group placeholder
  (`--group-dummy-user`) is never a member here. A group created with
  members publishes `created` only, its members in `$members`.
- `deleted`: the entry becomes a tombstone (the deleted attribute takes the
  deleted value), or an entry that is not a tombstone is removed.

An account is locked when its lock attribute holds the lock value, by default
the ppolicy administrative lock `000001010000Z`. Any other value, such as the
timestamp of a ppolicy lockout after failed binds, is not a lock here.

A tombstone announces nothing else: the write that makes it does not also
publish `disabled`, later changes to it (a lock written afterwards included)
publish nothing, and removing it publishes nothing, since its deletion was
already announced.

A publish that fails is logged as an error, and the next targets are still
published. It never fails the write that caused it, and the event is not
replayed: writing the same value again changes nothing, so it publishes
nothing. With `core/twake/tombstone`, a lost `deleted` is published again by
deleting the tombstone once more (see below); a lost `disabled`, `enabled`,
`created` or `roleChanged` has no such path.

The lock attribute is requested by name when the entry is read, so an
operational one such as `pwdAccountLockedTime` is seen on both sides.

## What is not published

- A rename or a move publishes nothing. The `$dn.*` groups of the new DN may
  then differ from the ones consumers know, and an entry moved into or out of
  a rule's pattern publishes neither `created` nor `deleted`.
- A tombstone cannot be restored. Clearing its deleted attribute is not a
  supported operation: it publishes nothing, whatever else the same write
  changes, and later changes are published again as for any account, to
  consumers that consider it deleted.
- A change made outside LDAP-Rest is not seen. A ppolicy lockout after failed
  binds is written by the directory itself, and holds a timestamp rather than
  the lock value: it publishes nothing, and neither does clearing it.

## Deployments with other plugins

- `core/twake/tombstone` answers a second delete of a tombstone without
  writing anything, and fires `twakedeletionreplay`; this plugin then
  publishes `deleted` again, with the tombstone as it is (same deletion date).
  This explicit delete is how a `deleted` event a broker outage lost is
  replayed.
- `core/twake/cozyProvision` and `core/twake/clouderyProvision` publish their
  own deletion event on `--cozy-user-deleted-routing-key`. When a `deleted`
  rule here publishes it, set that option to `""`. Turning it off without a
  `deleted` rule leaves no deletion event at all; keeping both publishes it
  twice.
- `core/ldap/trash` moves a deleted entry instead of removing it, and a move
  made by the trash is not seen by `core/ldap/onChange`. A deletion in a
  branch the trash watches publishes nothing.

## Configuration

```bash
--plugin core/twake/lifecycleEvents \
--twake-lifecycle-role-attribute title \
--twake-lifecycle-lock-attribute pwdAccountLockedTime \
--twake-lifecycle-lock-value 000001010000Z \
--twake-lifecycle-deleted-attribute employeeType \
--twake-lifecycle-deleted-value deleted \
--twake-lifecycle-deleted-at-attribute roomNumber \
--twake-lifecycle-deleted-at-format iso8601 \
--twake-lifecycle-rules /etc/ldap-rest/lifecycle-rules.json
```

- `--twake-lifecycle-role-attribute`: empty means no `roleChanged`.
- `--twake-lifecycle-lock-attribute`, `--twake-lifecycle-lock-value`: default
  to `--scim-user-lock-attribute` and `--scim-user-lock-value`, so SCIM
  `active` and the events agree; SCIM's value only goes with SCIM's
  attribute. `pwdAccountLockedTime` defaults to `000001010000Z`; any other
  attribute needs its value, or the server does not start, as for
  [SCIM](scim.md).
  Only changes written through LDAP-Rest are seen: a lockout set by the
  directory publishes nothing.
- `--twake-lifecycle-deleted-attribute`, `--twake-lifecycle-deleted-value`
  (default `TRUE`, compared case-insensitively): what marks a tombstone. Empty
  means entries are never tombstones, and only a removal publishes `deleted`.
- `--twake-lifecycle-deleted-at-attribute`,
  `--twake-lifecycle-deleted-at-format` (`iso8601`, the default, or
  `generalizedTime`): the deletion date. It is always published as ISO 8601.
- `--twake-lifecycle-member-attribute` (default `member`): the attribute
  `memberAdded`, `memberRemoved` and member lists read.
- `--twake-lifecycle-rules`: a JSON file, or the JSON itself.

Each option has a `DM_` environment variable, for example
`DM_TWAKE_LIFECYCLE_RULES`. The events go through `core/rabbitmq`. With rules
configured, the server does not start without `--rabbitmq-url`, nor when
that broker cannot be reached. An event that finds no broker later on is
lost, and logged as an error.

## Rules

The rules are an array. The first rule whose `dn` regular expression matches
the entry's DN (case-insensitively) decides what is published; an entry no
rule matches publishes nothing.

The DN is matched without spaces around its separators, and with escaped
commas written `\2C`: `uid=a\, b, ou=users,…` is read as `uid=a\2C b,ou=users,…`,
so `(?<id>[^,]+)` takes the whole value. A `$dn.name` group is unescaped:
`a, b`.

```json
[
  {
    "dn": "^uid=(?<id>[^,]+),ou=users,dc=example,dc=com$",
    "exchange": "accounts",
    "payload": {
      "id": "$dn.id",
      "email": "$mail",
      "domain": "$mail|domain",
      "role": "$title",
      "timestamp": "$now"
    },
    "events": {
      "created": "account.created",
      "roleChanged": {
        "routingKey": "account.role.changed",
        "payload": {
          "id": "$dn.id",
          "role": "$title",
          "previousRole": "$previous.title"
        }
      },
      "disabled": "account.disabled",
      "enabled": "account.enabled",
      "deleted": [
        "account.deleted",
        {
          "exchange": "notifications",
          "routingKey": "account.deleted",
          "when": { "$businessCategory": "user_request" },
          "payload": { "id": "$dn.id", "mobile": "$previous.mobile" }
        }
      ]
    }
  }
]
```

An event takes one target or a list of them, published in order. A target is
a routing key, or an object with:

- `routingKey`
- `exchange`: defaults to the rule's
- `payload`: replaces the rule's `payload`
- `when`: publish only if every source equals its value; a value starting with
  `!` means "differs from"

Payload and `when` values are sources:

- `$attr`: the attribute after the write; for a removed entry, which has no
  "after", the attribute before it
- `$previous.attr`: the attribute before the write
- `$dn.name`: a named group of the rule's `dn` expression
- `$context.actor`, `$context.requestId`, `$context.source`: who made the
  write, the request it belongs to, and the API it came through (`rest`,
  `scim`); left out for a write no request made, such as a scheduled task
- `$changed.attr`: the attribute after the write, only if the write changed
  it; an attribute the write removed gives `""`
- `$attr|domain`, `$previous.attr|domain`: what follows the `@`
- `$now`: the current time, ISO 8601
- anything else: the value itself

`$attr` and `$previous.attr` carry the first value of a multi-valued
attribute. A source with no value leaves its field out.

A payload field can also list members, as an object with one key:

- `$members`: the members after the write
- `$added`, `$removed`: the members `memberAdded` and `memberRemoved` are about

```json
"members": { "$added": { "username": "$uid", "email": "$mail" } }
```

Each member is read once, and shaped by the object it maps to, whose
sources are its own attributes (`$attr`) or plain values; any other source is
refused at startup. A tombstone is left
out, and a target whose `$added` or `$removed` is left empty publishes
nothing. A member no longer in the directory is known by its RDN alone:
`uid=jdoe,…` gives `{ "username": "jdoe" }` above. A group of 1,000 members
takes 1,000 reads, one after the other, off the path of the write's
response. A member that cannot be read, for a reason other than being gone,
drops that target, logged as an error: a member the service account may not
read silences every target of the group that lists its members. Every message carries
a random AMQP `messageId`.

A source can read any attribute of the entry: `$userPassword` would put the
password hash in the message.

The rules are checked at startup: a malformed one, such as a payload value
that is not a string, stops the server with an error naming its `dn`.

## Dependencies

```
core/twake/lifecycleEvents
  ├─ requires: core/ldap/onChange
  └─ requires: core/rabbitmq
```
