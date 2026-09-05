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

It has no options. It answers through whichever loaded plugin carries the
`authz` role _and_ can say who may do what where — one implementing
`resolveUser`, `getAuthorizedBranches` and `getUserPermissions`. Both
[authz-linid1](authz-linid1.md) and [authz-per-branch](authz-per-branch.md)
do, and this endpoint works with either without knowing which.

The role alone is not enough. [authz-per-route](authz-per-route.md) gates URLs
and [authz-dynamic](authz-dynamic.md) reads a token: both carry the `authz`
role and implement none of those three methods, so this endpoint passes them
over — loading one beside a branch-level plugin changes the answer not at all.
A server whose only authorization plugin is one of those has nothing to
describe a scope with, and the answer is the unrestricted one shown below: a
client built on it shows every button, and a refusal, when it comes, comes from
the route or the token rather than from the scope.

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
      "create": false
    }
  ]
}
```

`name` and `path` come from the branch entry itself, so an interface can show
the scope in the directory's own words rather than as a raw DN.

`create` answers "may I add one of these?". An ordinary entry is scoped by the
organization it is attached to, so the answer is yes as soon as the caller may
write in a branch they administer; organizations are the exception, since they
live in the tree itself and need write permission on the node they hang from —
the top of the tree, which is where a new organization goes when the client
names no parent. A local administrator of one branch therefore reads
`create: false` for organizations, and creates sub-organizations under their own
node by naming it as `parentDn`.

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
