# authzDynamic — LDAP-backed tokens + per-branch authorization

The `authzDynamic` plugin combines **bearer-token authentication** and
**per-branch authorization** in a single plugin, sourced entirely from a
dedicated LDAP branch. Adding, rotating, or revoking a token — or changing its
ACL — is a matter of writing to LDAP: no process restart, no config file.

This is the recommended building block for multi-tenant deployments where
each SCIM client (or REST API consumer) is scoped to its own subtree.

## How it works

1. The plugin loads all entries under `--authz-dynamic-base` and caches them.
2. On every incoming request, it reads `Authorization: Bearer <token>` and
   verifies the token against the `userPassword` hash of each cached entry
   (timing-safe comparison).
3. On a match, the plugin sets `req.user` to the tenant name and records the
   token's ACL in an `AsyncLocalStorage` context.
4. Downstream LDAP operations (via `ldapActions.search / add / modify / delete / rename`) trigger authz hooks that read the active token from the async context and throw if the requested DN is outside the allowed branches.
5. The cache refreshes on a TTL (default 60 s) or on demand via a protected
   reload endpoint.

## Configuration

```bash
node lib/bin/index.js \
  --ldap-url ldap://ldap.internal \
  --ldap-base dc=example,dc=com \
  --ldap-dn cn=admin,dc=example,dc=com --ldap-pwd '***' \
  \
  --plugin core/auth/authzDynamic \
  --authz-dynamic-base ou=authz-tokens,dc=example,dc=com \
  --authz-dynamic-cache-ttl 60 \
  --authz-dynamic-reload-endpoint
```

### CLI / environment

| Argument                           | Environment                         | Default        | Purpose                                                               |
| ---------------------------------- | ----------------------------------- | -------------- | --------------------------------------------------------------------- |
| `--authz-dynamic-base`             | `DM_AUTHZ_DYNAMIC_BASE`             | — (required)   | LDAP branch that contains the token entries                           |
| `--authz-dynamic-cache-ttl`        | `DM_AUTHZ_DYNAMIC_CACHE_TTL`        | `60`           | Cache refresh interval in seconds                                     |
| `--authz-dynamic-token-attribute`  | `DM_AUTHZ_DYNAMIC_TOKEN_ATTRIBUTE`  | `userPassword` | Attribute holding the hashed bearer token                             |
| `--authz-dynamic-config-attribute` | `DM_AUTHZ_DYNAMIC_CONFIG_ATTRIBUTE` | `description`  | Attribute holding the JSON ACL document                               |
| `--authz-dynamic-tenant-attribute` | `DM_AUTHZ_DYNAMIC_TENANT_ATTRIBUTE` | `cn`           | Attribute from which `req.user` is read                               |
| `--authz-dynamic-reload-endpoint`  | `DM_AUTHZ_DYNAMIC_RELOAD_ENDPOINT`  | `false`        | Register `POST /api/v1/authz-dynamic/reload` for manual cache refresh |
| `--authz-dynamic-bypass`           | `DM_AUTHZ_DYNAMIC_BYPASS`           | _(empty)_      | Who may reach the directory without one of these tokens (see below)   |

### Loading this plugin beside another authenticator

The dispatcher runs every authentication plugin claiming a request's path,
so a request can arrive here already identified by another one. Until 0.9.0
this plugin stepped aside whenever that happened, and the token ACLs were
then applied to nothing: with `core/auth/token` loaded beside it, a static
token reached the whole directory as an unscoped administrator — or was
refused for lacking a dynamic token, depending on which plugin had been
registered first.

The ACLs now apply to whatever token the request carries, whoever else
identified it, and anything allowed past them without a token is named:

| `--authz-dynamic-bypass` | Effect                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| _(empty, the default)_   | Nobody. A request must carry one of these tokens                                                    |
| `any-authenticated`      | Anything another plugin authenticated — the behaviour before 0.9.0                                  |
| `trusted-proxy`          | A request from a trusted proxy **that named a caller** (`req.trustedProxy` and `req.proxyAuthUser`) |
| any other value          | The identity another authenticator publishes in `req.user`, e.g. a name from `--auth-token`         |

Values combine: `--authz-dynamic-bypass trusted-proxy --authz-dynamic-bypass ops-admin`.

`trusted-proxy` requires the proxy to have named someone. `trustedProxy`
marks the _address_ it trusts and fills `proxyAuthUser` only when the
request carried the authentication header it expects, so accepting the mark
alone would hand the whole directory to every host of the `--trusted-proxy`
range — `10.0.0.0/8` being all of it.

A bypassed request carries **no** token, so no ACL is enforced on it — that
is what a bypass is. Each one is logged at `info` with the reason that let it
through, and a configuration loading this plugin beside another
authenticator says so once at startup.

The answer no longer depends on registration order: when the bypass names an
identity another plugin has not published yet, the verdict waits until every
authenticator has run.

## Token entry shape

Each token is a plain LDAP entry under `--authz-dynamic-base`. Minimal
requirements: `cn` (token identifier), `userPassword` (the hashed secret),
and a JSON ACL document in `description` (by default — override via
`--authz-dynamic-config-attribute`).

```ldif
dn: cn=acme,ou=authz-tokens,dc=example,dc=com
objectClass: top
objectClass: inetOrgPerson
cn: acme
sn: acme
userPassword: {SSHA}eFt2wP4ykczHzV9pzE3CH3k1t9M=
description: {
 "tenant": "acme",
 "bases": [
  { "dn": "ou=users,ou=acme,dc=example,dc=com",  "read": true, "write": true, "delete": true },
  { "dn": "ou=groups,ou=acme,dc=example,dc=com", "read": true, "write": true, "delete": true }
 ]
}
```

### ACL JSON

```json
{
  "tenant": "acme",
  "bases": [
    { "dn": "<branch DN>", "read": true, "write": true, "delete": true }
  ]
}
```

- **Sub-branch matching**: a permission on `ou=acme,dc=example,dc=com`
  automatically covers `ou=users,ou=acme,…` and any sub-branch.
- Absent flags default to `false`.
- `tenant` is optional; if omitted, `req.user` falls back to the value of the
  configured `tenantAttribute` (default `cn`).

### Supported userPassword schemes

Handled by a constant-time verifier (`authzDynamicHash.ts`):

| Scheme                                | Notes                                                |
| ------------------------------------- | ---------------------------------------------------- |
| `{SSHA}`                              | salted SHA-1 — OpenLDAP default, recommended minimum |
| `{SHA}`                               | unsalted SHA-1 — legacy                              |
| `{SSHA256}` / `{SHA256}`              | salted / unsalted SHA-256                            |
| `{SSHA512}` / `{SHA512}`              | salted / unsalted SHA-512                            |
| `{SMD5}` / `{MD5}`                    | salted / unsalted MD5 — legacy, avoid                |
| `{CLEARTEXT}` / `{PLAIN}` / no prefix | cleartext — test environments only                   |

To generate an `{SSHA}` hash with OpenLDAP tools: `slappasswd -h '{SSHA}'`.
To generate programmatically, `ssha(token)` is also exported from
`authzDynamicHash.ts` for scripts.

## Usage with SCIM

This is the combination the plugin was designed for:

```bash
node lib/bin/index.js \
  --ldap-base dc=example,dc=com \
  --ldap-dn cn=admin,dc=example,dc=com --ldap-pwd '***' \
  \
  --plugin core/auth/authzDynamic \
  --authz-dynamic-base ou=authz-tokens,dc=example,dc=com \
  \
  --plugin core/scim \
  --scim-user-base-template  'ou=users,ou={user},dc=example,dc=com' \
  --scim-group-base-template 'ou=groups,ou={user},dc=example,dc=com'
```

Each token's `tenant` field populates `req.user`, which the SCIM plugin uses
to resolve its LDAP bases via the `{user}` template. Combined with the token's
ACL, the client is cryptographically constrained to its own SCIM subtree.

## Operational notes

- **Cache**: read entries are kept in memory. A failed reload (LDAP hiccup)
  keeps the previous snapshot in use — no request is ever served with an
  empty cache unless the very first load fails.
- **Reload endpoint**: when `--authz-dynamic-reload-endpoint` is set, any
  **already-authenticated** token can call `POST /api/v1/authz-dynamic/reload`
  to force an immediate refresh. Useful after provisioning a new token.
- **Deletion**: deleting a token entry from LDAP invalidates it within
  `--authz-dynamic-cache-ttl` seconds (or immediately if a reload is
  triggered). Rotate compromised secrets this way.
- **Audit**: every unauthorized attempt is logged at `warn` with a masked
  token (first 8 chars + `...`). Every authorization failure is logged at
  `error` via the DM error middleware.
- **configApi**: when `core/configApi` is loaded, the plugin publishes a
  compact status under `features.authzDynamic` (token count, base DN, cache
  TTL, reload endpoint URL) — never hashes or per-token DNs.

## Security considerations

- **Secret storage**: always hash `userPassword` (`{SSHA}` or better). The
  plugin refuses unknown scheme prefixes, but accepts cleartext — do not
  deploy cleartext secrets in production.
- **Timing**: comparisons run through `crypto.timingSafeEqual` or a buffer
  wrapper, preventing timing oracles on the secret.
- **Composition**: loading another authenticator on the same paths means a
  request can arrive already identified. It is still checked against the
  token it carries; what may pass without one is `--authz-dynamic-bypass`,
  and nothing else.
- **Scope escape**: the authz hooks check every LDAP operation's DN against
  the token's ACL. The active token is carried via `AsyncLocalStorage`, so it
  applies even to plugins that do not thread `req` down to `ldapActions`.
- **Binding credentials**: the DM bind user still has admin access — the
  plugin's isolation is logical (path prefix check), not LDAP-layer ACL. For
  a second layer of defence, configure OpenLDAP ACLs to match.

## Example: listing a tenant's configuration

With `core/configApi` loaded:

```bash
curl -H 'Authorization: Bearer <token>' http://localhost:8081/api/v1/config
```

The response contains (trimmed):

```json
{
  "features": {
    "authzDynamic": {
      "enabled": true,
      "base": "ou=authz-tokens,dc=example,dc=com",
      "cacheTtlSeconds": 60,
      "tokenCount": 17,
      "tokenAttribute": "userPassword",
      "configAttribute": "description",
      "tenantAttribute": "cn",
      "reloadEndpoint": "/api/v1/authz-dynamic/reload"
    }
  }
}
```
