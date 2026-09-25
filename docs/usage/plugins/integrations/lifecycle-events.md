# Lifecycle Events

`core/twake/lifecycleEvents` publishes an account's lifecycle to RabbitMQ from
the directory write itself. REST, SCIM and any other plugin writing through
LDAP-Rest announce the same events, with the same payloads.

Which entries are accounts, which attributes carry the role, the lock and the
deletion, and where each event goes are configuration.

## Events

- `created`: an entry is added.
- `roleChanged`: the role attribute gets a different value.
- `disabled`: the lock attribute is set.
- `enabled`: the lock attribute is cleared.
- `deleted`: the deleted attribute is written with the deleted value (the
  entry becomes a tombstone), or an entry that is not a tombstone is removed.

A tombstone announces nothing else: the write that makes it does not also
publish `disabled`, later changes to it publish nothing, and removing it
publishes nothing, since its deletion was already announced. Writing the
deleted value again on a tombstone publishes `deleted` again, which replays an
event a broker outage lost.

A publish that fails is logged. It never fails the write that caused it.

Erasing a tombstone (`core/twake/tombstone`) also removes it from its groups. No rule
should match those group entries: nothing tells the plugin that these
membership changes belong to an erase, so it would publish them.

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
  (default `TRUE`): what marks a tombstone. Empty means entries are never
  tombstones, and only a removal publishes `deleted`.
- `--twake-lifecycle-deleted-at-attribute`,
  `--twake-lifecycle-deleted-at-format` (`iso8601`, the default, or
  `generalizedTime`): the deletion date. It is always published as ISO 8601.
- `--twake-lifecycle-rules`: a JSON file, or the JSON itself.

Each option has a `DM_` environment variable, for example
`DM_TWAKE_LIFECYCLE_RULES`. The plugin needs `--rabbitmq-url`.

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

- `$attr`: the attribute after the write (its first value)
- `$previous.attr`: the attribute before the write
- `$dn.name`: a named group of the rule's `dn` expression
- `$attr|domain`, `$previous.attr|domain`: what follows the `@`
- `$now`: the current time, ISO 8601
- anything else: the value itself

A source with no value leaves its field out. Every message carries a random
AMQP `messageId`.

## Dependencies

```
core/twake/lifecycleEvents
  ├─ requires: core/ldap/onChange
  └─ requires: core/rabbitmq
```
