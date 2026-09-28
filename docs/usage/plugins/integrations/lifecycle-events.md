# Lifecycle Events

`core/twake/lifecycleEvents` publishes an account's lifecycle to RabbitMQ from
the directory write itself. REST, SCIM and any other plugin writing through
LDAP-Rest announce the same events, with the same payloads.

Which entries are accounts, which attributes carry the role, the lock and the
deletion, and where each event goes are configuration.

## Events

Each event is a change of state, read from the entry before and after a write
(`onLdapEntryChange`, from `core/ldap/onChange`). A write that changes nothing
publishes nothing.

- `created`: an entry is added. An entry added with the lock attribute set,
  as a SCIM create with `active: false` does, publishes `created` then
  `disabled`.
- `roleChanged`: the role attribute gets different values. Case is ignored:
  `Admin` and `admin` are one role.
- `disabled`: the lock attribute is set.
- `enabled`: the lock attribute is cleared.
- `deleted`: the entry becomes a tombstone (the deleted attribute takes the
  deleted value), or an entry that is not a tombstone is removed.

A tombstone announces nothing else: the write that makes it does not also
publish `disabled`, later changes to it (a lock written afterwards included)
publish nothing, and removing it publishes nothing, since its deletion was
already announced.

A publish that fails is logged. It never fails the write that caused it, and
the event is not replayed: writing the same value again changes nothing, so it
publishes nothing.

The lock attribute is requested by name when the entry is read, so an
operational one such as `pwdAccountLockedTime` is seen on both sides.

## What is not published

- A rename or a move publishes nothing. The `$dn.*` groups of the new DN may
  then differ from the ones consumers know, and an entry moved into or out of
  a rule's pattern publishes neither `created` nor `deleted`.
- Clearing the deleted attribute of a tombstone (a restore) publishes nothing,
  whatever else the same write changes. Later changes are published again, as
  for any account.
- A change made outside LDAP-Rest is not seen. A lock set by the directory
  itself, such as a ppolicy lockout after failed binds, publishes no
  `disabled`, and the unlock through LDAP-Rest that follows publishes
  `enabled` with no `disabled` before it.
- The rule's `dn` expression is matched against the DN as the write gave it,
  not a normalized form: `uid=alice, ou=users,…`, with a space, does not match
  a pattern written without one.

## Deployments with other plugins

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
--twake-lifecycle-deleted-attribute employeeType \
--twake-lifecycle-deleted-value deleted \
--twake-lifecycle-deleted-at-attribute roomNumber \
--twake-lifecycle-deleted-at-format iso8601 \
--twake-lifecycle-rules /etc/ldap-rest/lifecycle-rules.json
```

- `--twake-lifecycle-role-attribute`: empty means no `roleChanged`.
- `--twake-lifecycle-lock-attribute`: defaults to
  `--scim-user-lock-attribute`, so SCIM `active` and the events agree.
- `--twake-lifecycle-deleted-attribute`, `--twake-lifecycle-deleted-value`
  (default `TRUE`, compared case-insensitively): what marks a tombstone. Empty
  means entries are never tombstones, and only a removal publishes `deleted`.
- `--twake-lifecycle-deleted-at-attribute`,
  `--twake-lifecycle-deleted-at-format` (`iso8601`, the default, or
  `generalizedTime`): the deletion date. It is always published as ISO 8601.
- `--twake-lifecycle-rules`: a JSON file, or the JSON itself.

Each option has a `DM_` environment variable, for example
`DM_TWAKE_LIFECYCLE_RULES`. The events go through `core/rabbitmq`: without a
broker (no `--rabbitmq-url`, or one that cannot be reached), they are lost,
and each one is logged as an error.

## Rules

The rules are an array. The first rule whose `dn` regular expression matches
the entry's DN (case-insensitively) decides what is published; an entry no
rule matches publishes nothing.

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
- `$attr|domain`, `$previous.attr|domain`: what follows the `@`
- `$now`: the current time, ISO 8601
- anything else: the value itself

`$attr` and `$previous.attr` carry the first value of a multi-valued
attribute. A source with no value leaves its field out. Every message carries
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
