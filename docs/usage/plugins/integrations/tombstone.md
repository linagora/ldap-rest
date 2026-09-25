# Tombstone

`core/twake/tombstone` turns the delete of an account into a tombstone. The
entry stays, so its identifiers cannot be taken by a new account, but it is
flagged as deleted, dated, locked, carries the reason, and loses the
attributes the deployment names.

A tombstone is erased later, from an operator's decision: once the deletion
is old enough, or right away when forced.

## Behaviour

- A delete of an entry whose DN matches `--twake-tombstone-dn` writes, in one
  modify: the deleted attribute, the deletion date (now), the reason, the
  lock, and removes `--twake-tombstone-clear-attributes`. Other entries are
  deleted as usual.
- A delete of an existing tombstone rewrites the deleted attribute only and
  keeps the date. With [lifecycle events](lifecycle-events.md) loaded, this
  publishes the deletion again.
- The tombstone keeps its group memberships until it is erased.
- SCIM treats a tombstone as gone: reads answer 404, lists leave it out, and
  a create with the same identity erases the tombstone and creates a new
  entry.
- Erasing removes the entry's group memberships, then the entry. It publishes
  nothing.

The tombstone is written after every other plugin has judged the delete, so
a delete that an authorization plugin refuses writes nothing.

## Reason

The reason is, in order:

- the one given to `tombstone(dn, reason, req)` by another plugin;
- the `--twake-tombstone-reason-header` request header;
- `--twake-tombstone-default-reason`.

When `--twake-tombstone-reasons` is set, any other reason is refused with a 400. Otherwise a reason is letters, digits, `_`, `.` or `-`.

## Erase

```http
POST /api/v1/twake/tombstones/erase
Content-Type: application/json

{ "dn": "uid=jdoe,ou=users,dc=example,dc=com", "force": false }
```

- `200`: erased.
- `404`: no tombstone at this DN.
- `409`: the deletion is younger than `--twake-tombstone-erase-min-age` and
  `force` is not true.

Other plugins call `erase(dn, { force, req })`.

## Configuration

The tombstone attributes are the lifecycle ones, shared with
[lifecycle events](lifecycle-events.md):

```bash
--plugin core/twake/tombstone \
--twake-lifecycle-lock-attribute pwdAccountLockedTime \
--twake-lifecycle-lock-value 000001010000Z \
--twake-lifecycle-deleted-attribute employeeType \
--twake-lifecycle-deleted-value deleted \
--twake-lifecycle-deleted-at-attribute roomNumber \
--twake-lifecycle-deleted-at-format iso8601 \
--twake-lifecycle-reason-attribute businessCategory \
--twake-tombstone-dn '^uid=[^,]+,ou=users,dc=example,dc=com$' \
--twake-tombstone-dn '^uid=[^,]+,ou=[^,]+,ou=organizations,dc=example,dc=com$' \
--twake-tombstone-reasons deleted,user_request \
--twake-tombstone-clear-attributes mobile,telephoneNumber \
--twake-tombstone-erase-min-age 2592000 \
--twake-tombstone-group-bases ou=groups,dc=example,dc=com
```

- `--twake-lifecycle-deleted-attribute`: required.
- `--twake-lifecycle-lock-value`: defaults to `--scim-user-lock-value`, then
  `000001010000Z`.
- `--twake-lifecycle-reason-attribute`: empty means the reason is not
  recorded.
- `--twake-tombstone-dn`: regular expressions, matched case-insensitively. A
  DN holds commas, so in `DM_TWAKE_TOMBSTONE_DN` end each one with `;`.
- `--twake-tombstone-default-reason`: default `deleted`.
- `--twake-tombstone-reason-header`: default `x-deletion-reason`.
- `--twake-tombstone-erase-min-age`: seconds, default 30 days.
- `--twake-tombstone-group-bases`: where memberships are looked for at erase,
  by `member`. Defaults to `--ldap-group-base`, then `--ldap-base`. In the
  environment variable, end each base with `;`.
