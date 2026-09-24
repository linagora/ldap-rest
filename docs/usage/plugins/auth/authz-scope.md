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

It answers through a loaded plugin that carries the `authz` role _and_ can
say who may do what where — one implementing `resolveUser`,
`getAuthorizedBranches` and `getUserPermissions`. Both
[authz-linid1](authz-linid1.md) and [authz-per-branch](authz-per-branch.md)
do, and this endpoint works with either without knowing which.

| CLI                    | Env                     | Default | Description                                                   |
| ---------------------- | ----------------------- | ------- | ------------------------------------------------------------- |
| `--authz-scope-source` | `DM_AUTHZ_SCOPE_SOURCE` |         | The plugin, by instance name, that describes a caller's scope |

### Which plugin answers

The caller is resolved under the name the hooks key on — `req.user`, or
`req.userName` with `--authz-identity req.userName` — so the scope described
is the one enforced.

Only a plugin that judges the caller answers for them: one scoped with
`authz_for` to other authentication plugins is not this caller's model, and
is passed over (see [several authorization
plugins](README.md#several-authorization-plugins)).

When more than one judges the caller — two branch-level plugins combined with
`--authz-combine` — the hooks apply both and this endpoint can describe only
one. `--authz-scope-source` names it. Without it, the first loaded answers,
and for plugins outside the priority list that is import order, which nobody
chose: the server says so at startup, and the answer lists every plugin
judging the caller under `sources`, the one it comes from under `source`. A
name that is not a loaded plugin able to describe a scope is refused at
startup.

### When nothing can describe the scope

[authz-per-route](authz-per-route.md) gates URLs and
[authz-dynamic](authz-dynamic.md) reads a token: both carry the `authz` role,
neither resolves a user or a branch. When they judge the caller and no
branch-level plugin does, no model can say what the caller may do, and the
answer says that rather than guessing:

```json
{
  "user": "alice",
  "unrestricted": false,
  "described": false,
  "source": null,
  "sources": ["authzPerRoute"],
  "branches": [],
  "entities": []
}
```

This endpoint used to answer `unrestricted: true` with `create: true` on
every entity there — an authorization judgement handed to a client that acts
on it, while the route or the token refused. A client that reads an entity
missing from `entities` as not creatable offers nothing.

## Endpoint

```
GET /api/v1/authz/scope
```

```json
{
  "user": "uid=alice,ou=users,dc=example,dc=com",
  "unrestricted": false,
  "described": true,
  "source": "authzLinid1",
  "sources": ["authzLinid1"],
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

`create` answers "may I add one of these?", on the rule the add hook enforces.
An entry that can carry the organization link (its schema declares the
configured link attribute) is scoped by the organization it is attached to, so
the answer is yes as soon as the caller may write in a branch they administer.
One that cannot — a position, a nomenclature row — is checked against the
branch it lands in, so the answer is whether the caller may write there.
Organizations are the other exception, since they live in the tree itself and
need write permission on the node they hang from — the top of the tree, which
is where a new organization goes when the client names no parent. A local administrator of one branch therefore reads
`create: false` for organizations, and creates sub-organizations under their own
node by naming it as `parentDn`.

With no authorization plugin judging the caller the server grants
everything, and the answer says so:

```json
{
  "user": "alice",
  "unrestricted": true,
  "described": true,
  "source": null,
  "sources": [],
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
