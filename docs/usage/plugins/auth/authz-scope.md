# Authorization Scope Plugin

Tells a client what the signed-in administrator may actually do, before it
offers them a button that will fail.

In a local-administration model the scope _is_ the interface: a manager
administers a few branches of the tree and nothing else, and an application
that cannot name those branches leaves them guessing. This endpoint answers
both halves — which branches, and which entities can be created — by asking
whichever authorization plugin is in force.

## Configuration

```bash
--plugin core/auth/authzScope
```

It has no options. It finds the loaded authorization plugin by its role, so it
works with [authz-linid1](authz-linid1.md), [authz-per-branch](authz-per-branch.md)
or [authz-dynamic](authz-dynamic.md) without knowing which.

## Endpoint

```
GET /api/v1/authz/scope
```

```json
{
  "user": "uid=alice,ou=users,dc=example,dc=com",
  "unrestricted": false,
  "branches": [
    {
      "dn": "ou=Sales,ou=organization,dc=example,dc=com",
      "name": "Sales",
      "path": "Acme / Sales",
      "read": true,
      "write": true,
      "delete": true
    }
  ],
  "entities": [
    { "name": "users", "base": "ou=users,dc=example,dc=com", "create": true },
    { "name": "groups", "base": "ou=groups,dc=example,dc=com", "create": true },
    {
      "name": "organizations",
      "base": "ou=organization,dc=example,dc=com",
      "create": true
    }
  ]
}
```

`name` and `path` come from the branch entry itself, so an interface can show
the scope in the directory's own words rather than as a raw DN.

`create` answers "may I add one of these?". An ordinary entry is scoped by the
organization it is attached to, so the answer is yes as soon as the caller
administers a branch; organizations are the exception, since they live in the
tree itself and need write permission on it.

With no authorization plugin loaded the server grants everything, and the
answer says so:

```json
{
  "user": "alice",
  "unrestricted": true,
  "branches": [],
  "entities": [
    { "name": "users", "base": "ou=users,dc=example,dc=com", "create": true }
  ]
}
```

## Errors

| Status | When                                                          |
| ------ | ------------------------------------------------------------- |
| `401`  | No authenticated user, or a user the directory cannot resolve |

## See also

- [authz-linid1](authz-linid1.md) — the local-administrator model this serves
- [authz-per-branch](authz-per-branch.md) — static per-branch permissions
