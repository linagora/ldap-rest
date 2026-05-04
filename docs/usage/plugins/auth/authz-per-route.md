# Route-Level Authorization (`authzPerRoute`)

Restricts access to specific HTTP routes based on the authenticated user's name
(`req.user`), which is set by an auth plugin such as `core/auth/token`.

This plugin complements `authzPerBranch` (LDAP-branch ACL) and `authzDynamic`
(LDAP-backed tokens): whereas those operate at the LDAP-branch level,
`authzPerRoute` works at the HTTP route level and needs no LDAP connection.

## Loading Order

**`authzPerRoute` must be loaded _after_ the auth plugin** (e.g. `core/auth/token`),
because it reads `req.user` which is set by the auth middleware.

```bash
--plugin core/auth/token \
--plugin core/auth/authzPerRoute
```

## Configuration

### CLI

```bash
--authz-per-route "full-access:*" \
--authz-per-route "updt-only:POST:/api/v1/ldap/updt" \
--authz-per-route "updt-only:GET:/api/v1/ldap/updt/**"
```

### Environment Variable

```bash
DM_AUTHZ_PER_ROUTE="full-access:*,updt-only:POST:/api/v1/ldap/updt,updt-only:GET:/api/v1/ldap/updt/**"
```

Multiple values are comma-separated. Repeating `--authz-per-route` on the CLI
is equivalent.

## Rule Syntax

Each entry has one of two forms:

| Form                         | Meaning                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `<user>:*`                   | Full wildcard — allow any method on any path                |
| `<user>:<METHOD>:<pathGlob>` | Allow only the given HTTP method on paths matching the glob |

- `<user>` — the value of `req.user` as set by the auth plugin.
- `<METHOD>` — an HTTP verb (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`,
  `OPTIONS`) or `*` (any verb).
- `<pathGlob>` — a glob pattern (not a regex). Patterns are implicitly
  anchored start-to-end. Rules:
  - `*` matches any sequence of characters **except** `/` (one path segment).
  - `**` matches any sequence of characters **including** `/` (multiple segments).
  - All other characters are matched literally — regex special characters (`.`, `+`,
    `?`, etc.) have no special meaning.

A user may have multiple entries; access is granted if **any** rule matches
(logical OR).

### Examples

```bash
# admin token: full access
full-access:*

# read-only token: GET only on exactly /api/hello
reader:GET:/api/hello

# update token: POST on exact path, GET on that path and all sub-paths
updt:POST:/api/v1/ldap/updt
updt:GET:/api/v1/ldap/updt**

# any method on a path and all sub-paths
any-method:*:/api/v1/ldap/users**

# match one level deep only (not /api/v1/ldap/users/uid=bob/sub)
one-level:GET:/api/v1/ldap/users/*
```

### Glob pattern quick reference

| Pattern              | Matches                                       | Does NOT match                          |
| -------------------- | --------------------------------------------- | --------------------------------------- |
| `/api/hello`         | `/api/hello`                                  | `/api/hello/sub`                        |
| `/api/hello**`       | `/api/hello`, `/api/hello/sub`, `/api/hello/sub/deep` | `/api/hell`                   |
| `/api/hello/**`      | `/api/hello/sub`, `/api/hello/sub/deep`       | `/api/hello`                            |
| `/api/hello/*`       | `/api/hello/sub`                              | `/api/hello`, `/api/hello/sub/deep`     |
| `/api/hello.bak`     | `/api/hello.bak`                              | `/api/helloXbak` (`.` is literal)       |

## Behavior

| Situation                                             | Result                                                 |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `req.user` is unset (no auth plugin ran)              | Pass through (`next()`) — let upstream auth return 401 |
| User authenticated but has no rules configured        | 403 Forbidden                                          |
| User has at least one matching rule                   | 200 / pass through                                     |
| User has rules but none match the current method+path | 403 Forbidden                                          |

## Full Example

```bash
DM_AUTH_TOKENS="tok-admin:admin,tok-ro:reader"
DM_AUTHZ_PER_ROUTE="admin:*,reader:GET:/api/v1/ldap/users**,reader:GET:/api/v1/ldap/groups**"

npx ldap-rest \
  --plugin core/auth/token \
  --plugin core/auth/authzPerRoute \
  --plugin core/ldap/users \
  --plugin core/ldap/groups \
  --ldap-url ldap://localhost:389 \
  ...
```

```bash
# admin: any request allowed
curl -H "Authorization: Bearer tok-admin" http://api/v1/ldap/users
curl -H "Authorization: Bearer tok-admin" -X DELETE http://api/v1/ldap/users/uid=bob,ou=users,dc=example,dc=org

# reader: GET allowed
curl -H "Authorization: Bearer tok-ro" http://api/v1/ldap/users   # 200

# reader: write denied
curl -H "Authorization: Bearer tok-ro" -X POST http://api/v1/ldap/users  # 403
```

## Difference vs. Other Authz Plugins

| Plugin           | Scope                          | Requires LDAP      |
| ---------------- | ------------------------------ | ------------------ |
| `authzPerRoute`  | HTTP method + path             | No                 |
| `authzPerBranch` | LDAP branch read/write/delete  | No (static config) |
| `authzDynamic`   | LDAP branch ACL stored in LDAP | Yes                |
