# SCIM 2.0 Plugin

The `scim` plugin exposes a [RFC 7643](https://datatracker.ietf.org/doc/html/rfc7643) /
[RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644) compliant endpoint at
`/scim/v2/*`, allowing identity providers like Okta, Microsoft Entra ID (Azure AD),
Google Workspace, and JumpCloud to provision users and groups against the underlying
LDAP directory.

## Overview

- Resources: `/Users`, `/Groups`
- Operations: GET, POST, PUT, PATCH, DELETE, Bulk
- Discovery: `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`
- SCIM filter syntax (RFC 7644 §3.4.2.2) translated to LDAP filters
- SCIM PATCH (RFC 7644 §3.5.2) translated to LDAP `ModifyRequest`
- Bulk (RFC 7644 §3.7) with cross-operation `bulkId` references
- Per-request base resolution (multi-tenant) via template or JSON map

The plugin sits on top of `ldapActions` and can operate fully independently from the
generic `ldap/users` / `ldap/groups` plugins — it only needs LDAP credentials and
target branches.

## Quick start

```bash
node lib/bin/index.js \
  --ldap-url ldap://localhost:389 \
  --ldap-base dc=example,dc=com \
  --ldap-dn cn=admin,dc=example,dc=com \
  --ldap-pwd admin \
  --plugin core/auth/token --auth-token 'my-secret:idp1' \
  --plugin core/scim \
  --scim-user-base ou=users,dc=example,dc=com \
  --scim-group-base ou=groups,dc=example,dc=com
```

All SCIM endpoints sit behind the auth middleware registered before the plugin
(Bearer token in this example).

## Configuration

### CLI / environment

| Argument | Environment | Default | Description |
|---|---|---|---|
| `--scim-prefix` | `DM_SCIM_PREFIX` | `/scim/v2` | Base URL path for all SCIM endpoints |
| `--scim-user-base` | `DM_SCIM_USER_BASE` | `{ldap_base}` | LDAP branch containing users |
| `--scim-group-base` | `DM_SCIM_GROUP_BASE` | `{ldap_base}` | LDAP branch containing groups |
| `--scim-user-base-template` | `DM_SCIM_USER_BASE_TEMPLATE` | — | DN template with `{user}` placeholder (see *multi-tenant*) |
| `--scim-group-base-template` | `DM_SCIM_GROUP_BASE_TEMPLATE` | — | Same for groups |
| `--scim-base-map` | `DM_SCIM_BASE_MAP` | — | Path to JSON file mapping authenticated user → `{userBase, groupBase}` |
| `--scim-user-object-class` | `DM_SCIM_USER_OBJECT_CLASSES` | `top, inetOrgPerson, organizationalPerson, person` | Object classes for created Users |
| `--scim-user-rdn-attribute` | `DM_SCIM_USER_RDN_ATTRIBUTE` | `uid` | RDN attribute for Users |
| `--scim-group-object-class` | `DM_SCIM_GROUP_OBJECT_CLASSES` | `top, groupOfNames` | Object classes for created Groups |
| `--scim-group-rdn-attribute` | `DM_SCIM_GROUP_RDN_ATTRIBUTE` | `cn` | RDN attribute for Groups |
| `--scim-id-attribute` | `DM_SCIM_ID_ATTRIBUTE` | `rdn` | `rdn` (default) or `entryUUID` for SCIM `id` |
| `--scim-user-mapping` | `DM_SCIM_USER_MAPPING` | — | Path to JSON mapping override |
| `--scim-group-mapping` | `DM_SCIM_GROUP_MAPPING` | — | Same for Groups |
| `--scim-max-results` | `DM_SCIM_MAX_RESULTS` | `200` | Hard cap on list results |
| `--scim-bulk-max-operations` | `DM_SCIM_BULK_MAX_OPERATIONS` | `100` | Max `/Bulk` operations per request |
| `--scim-bulk-max-payload-size` | `DM_SCIM_BULK_MAX_PAYLOAD_SIZE` | `1048576` | Max `/Bulk` payload size in bytes |
| `--scim-etag` | `DM_SCIM_ETAG` | `false` | Advertise ETag support in discovery (not yet implemented) |
| `--scim-base-url` | `DM_SCIM_BASE_URL` | auto from request | Override external base URL for `meta.location` values |

### Authentication

SCIM piggybacks on whichever auth plugin you load. The discovery endpoint
`/ServiceProviderConfig` reflects the active scheme automatically:

- `core/auth/token` → `oauthbearertoken`
- `core/auth/openidconnect` → `oauth2`
- `core/auth/hmac` → `httpbasic`

For Okta / Entra, load `core/auth/token` with a provisioning token.

## Endpoints

All responses have `Content-Type: application/scim+json`.

| Method | Path | Description |
|---|---|---|
| GET  | `/Users` | List Users (filter, pagination, sort) |
| GET  | `/Users/{id}` | Get a User |
| POST | `/Users` | Create a User |
| PUT  | `/Users/{id}` | Replace a User |
| PATCH| `/Users/{id}` | Partial update (add/remove/replace) |
| DELETE | `/Users/{id}` | Delete a User |
| GET/POST/PUT/PATCH/DELETE | `/Groups[/{id}]` | Same operations on Groups |
| POST | `/Bulk` | Batch operations with `bulkId` refs |
| GET  | `/ServiceProviderConfig` | Capabilities |
| GET  | `/ResourceTypes` / `/ResourceTypes/{name}` | Resource metadata |
| GET  | `/Schemas` / `/Schemas/{urn}` | Schema definitions |

### Default mapping (LDAP ⇄ SCIM User)

| SCIM | LDAP |
|---|---|
| `id` | `uid` (or `entryUUID`) |
| `userName` | `uid` |
| `externalId` | `employeeNumber` |
| `name.familyName` | `sn` |
| `name.givenName` | `givenName` |
| `name.formatted` | `cn` |
| `displayName` | `displayName` |
| `title` | `title` |
| `preferredLanguage` | `preferredLanguage` |
| `emails[primary=true].value` | `mail` |
| `emails[primary=false].value` | `mailAlternateAddress` |
| `phoneNumbers[primary=true].value` | `telephoneNumber` |
| `phoneNumbers[primary=false].value` | `mobile` |
| `active` | pseudo (false if `pwdAccountLockedTime` is set) |
| `meta.created` / `meta.lastModified` | `createTimestamp` / `modifyTimestamp` |

Override with `--scim-user-mapping /path/to/user-mapping.json` (same schema as
`static/schemas/scim/default-mapping.json`).

## Writing a custom mapping schema

The mapping file is a plain JSON document describing how each SCIM attribute is
projected to LDAP, and vice versa. A separate file is loaded for `--scim-user-mapping`
and `--scim-group-mapping`.

### File shape

```json
{
  "resourceType": "User",
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "entries": [
    { "scim": "<scim attribute>", "ldap": "<ldap attribute>" },
    ...
  ]
}
```

Each element of `entries` is a `MappingEntry` with the following optional fields:

| Field | Purpose |
|---|---|
| `scim` | **Required.** Top-level SCIM attribute name (`userName`, `displayName`, `emails`, …). |
| `ldap` | Simple 1:1 mapping to an LDAP attribute. |
| `ldapPrimary` | For multi-valued SCIM attributes (`emails`, `phoneNumbers`, …), the LDAP attribute that stores the *primary* value. |
| `ldapSecondary` | LDAP attribute that stores the *non-primary* values of the same SCIM attribute (array). |
| `sub` | Object that maps SCIM sub-attributes to LDAP attributes. Used for complex SCIM values like `name.familyName` → `sn`. |
| `multi` | `"array"` or `"single"` (default) — hints array serialization for `ldap`. |
| `readOnly` | `true` to skip this attribute on write (create/update ignore it). |
| `operational` | `true` for LDAP operational attributes (e.g. `entryUUID`) — loaded on read only. |

### Merging

The file you provide is **merged on top of the default mapping**: entries whose
`scim` key matches a default entry replace it; new entries are appended. So you can
override only what's different and inherit the rest.

### Example — adding the Enterprise User extension

```json
{
  "resourceType": "User",
  "schemas": [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
  ],
  "entries": [
    { "scim": "userName", "ldap": "sAMAccountName" },
    {
      "scim": "name",
      "sub": {
        "familyName": "sn",
        "givenName": "givenName",
        "formatted": "displayName"
      }
    },
    {
      "scim": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber",
      "ldap": "employeeNumber"
    },
    {
      "scim": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
      "ldap": "department"
    },
    {
      "scim": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager",
      "sub": { "value": "manager" }
    }
  ]
}
```

Save it as `/etc/ldap-rest/scim-enterprise.json` and load with
`--scim-user-mapping /etc/ldap-rest/scim-enterprise.json`.

### Example — multi-valued phone numbers with a custom LDAP attribute

```json
{
  "resourceType": "User",
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "entries": [
    {
      "scim": "phoneNumbers",
      "ldapPrimary": "telephoneNumber",
      "ldapSecondary": "otherTelephone",
      "multi": "array"
    }
  ]
}
```

On write, the entry marked `primary: true` (or the first one) lands in
`telephoneNumber`; the remaining values are written as an array to
`otherTelephone`. On read, both attributes are collected back into a SCIM
`phoneNumbers` array with the primary flag set on the `telephoneNumber` value.

### Filter and PATCH behavior

The mapping is authoritative for the **SCIM filter parser** (RFC 7644 §3.4.2.2)
and the **PATCH applicator** (RFC 7644 §3.5.2). A SCIM filter like
`department eq "Engineering"` will only translate to an LDAP filter if your
mapping contains an entry with `scim: "department"`; otherwise the server returns
`400 invalidFilter`. Same for PATCH: operations on unmapped paths produce
`400 invalidPath`.

### Schema advertisement

Schemas listed under `GET /scim/v2/Schemas` are read from
`static/schemas/scim/User.json` and `Group.json`. To expose a custom schema to
clients, extend those JSON files (or drop additional files in the same folder and
adjust the loader). Exposing a schema there is **independent** from the
LDAP↔SCIM projection: the schema file describes the public SCIM contract, the
mapping file describes the internal translation.

## Filter syntax

SCIM filters are translated to LDAP filters (RFC 4515). Values are always escaped
via `escapeLdapFilter()` — no LDAP injection is possible.

| SCIM | LDAP |
|---|---|
| `userName eq "alice"` | `(uid=alice)` |
| `name.familyName sw "Du"` | `(sn=Du*)` |
| `emails.value co "@example.com"` | `(mail=*@example.com*)` |
| `displayName pr` | `(displayName=*)` |
| `active eq true` | `(!(pwdAccountLockedTime=*))` |
| `a eq "x" and b eq "y"` | `(&(a=x)(b=y))` |
| `not (a eq "x")` | `(!(a=x))` |

Unknown SCIM attributes raise `400 invalidFilter`.

## Multi-tenant: per-user LDAP bases

SCIM does not expose any tenant concept to clients — resource `id`s are opaque
strings. Internally the plugin can route each authenticated identity to a
different LDAP subtree, so one `ldap-rest` instance can serve many tenants
without any client-visible distinction.

### How `req.user` is populated

Whichever auth plugin runs before SCIM must set `req.user` to a string that
identifies the caller. Supported out of the box:

| Auth plugin | `req.user` value |
|---|---|
| `core/auth/token` | the `name` field of `--auth-token "id:secret:name"` |
| `core/auth/openidconnect` | the subject / preferred_username from the OIDC token |
| `core/auth/hmac` | the HMAC key id |
| `core/auth/trustedProxy` | the value of `--trusted-proxy-auth-header` (default `Auth-User`) |
| `core/auth/llng` | the LemonLDAP::NG user id |

In the examples below we use `core/auth/token`, but any of the above works the
same way — the SCIM plugin only reads `req.user`.

### Three modes, evaluated in order

The plugin resolves `userBase` and `groupBase` on **every request**, in this
precedence:

1. Explicit entry in a JSON map keyed by `req.user` (`--scim-base-map`).
2. Wildcard `"*"` entry in the same JSON map (applied when no explicit match).
3. DN template with `{user}` placeholder (`--scim-user-base-template` /
   `--scim-group-base-template`).
4. Static value (`--scim-user-base` / `--scim-group-base`).
5. Global fallback (`--ldap-base`).

### Mode 1 — JSON map (explicit, arbitrary routing)

Use when different tenants live in unrelated branches of the tree, or when you
need to override group base independently of user base.

Create `/etc/ldap-rest/scim-tenants.json`:

```json
{
  "okta-acme": {
    "userBase":  "ou=users,ou=acme,dc=example,dc=com",
    "groupBase": "ou=groups,ou=acme,dc=example,dc=com"
  },
  "entra-globex": {
    "userBase":  "ou=users,ou=globex,dc=example,dc=com",
    "groupBase": "ou=groups,ou=globex,dc=example,dc=com"
  },
  "*": {
    "userBase":  "ou=users,dc=example,dc=com",
    "groupBase": "ou=groups,dc=example,dc=com"
  }
}
```

Run with:

```bash
node lib/bin/index.js \
  --ldap-base dc=example,dc=com \
  --ldap-dn cn=admin,dc=example,dc=com --ldap-pwd admin \
  --plugin core/auth/token \
  --auth-token 'okta-token:okta-acme' \
  --auth-token 'entra-token:entra-globex' \
  --plugin core/scim \
  --scim-base-map /etc/ldap-rest/scim-tenants.json
```

Okta authenticates with `Bearer okta-token` → `req.user = "okta-acme"` →
SCIM operates under `ou=acme`. Entra ID authenticates with `Bearer entra-token`
→ `req.user = "entra-globex"` → operates under `ou=globex`. Any other caller
falls back to the `"*"` entry.

### Mode 2 — Template (symmetric, naming-based)

Use when all tenants follow the same branch pattern and the tenant id happens to
be a safe DN value.

```bash
node lib/bin/index.js \
  ... \
  --plugin core/auth/token \
  --auth-token 'acme-secret:acme' \
  --auth-token 'globex-secret:globex' \
  --plugin core/scim \
  --scim-user-base-template  'ou=users,ou={user},dc=example,dc=com' \
  --scim-group-base-template 'ou=groups,ou={user},dc=example,dc=com'
```

The `{user}` placeholder is substituted with `req.user` **after being sanitized
by `escapeDnValue`**, so any DN-special characters in the identity are properly
escaped and cannot break out of the template. A caller authenticating as `acme`
will see `ou=users,ou=acme,dc=example,dc=com` as its user base.

The template is also honoured for the `"*"` wildcard values in a JSON map, if
those contain `{user}`.

### Mode 3 — Static (single-tenant)

If every caller targets the same subtree, just set:

```bash
--scim-user-base  ou=users,dc=example,dc=com
--scim-group-base ou=groups,dc=example,dc=com
```

No template, no map.

### Mixing modes

Nothing prevents combining them. A common pattern is: explicit map for a few
named partners, template for the common case, static fallback for untagged
tokens.

```bash
--scim-base-map          /etc/ldap-rest/partners.json        # explicit overrides
--scim-user-base-template 'ou=users,ou={user},dc=example,dc=com'
--scim-user-base          ou=users,dc=example,dc=com         # absolute fallback
```

### Debugging the resolution

Enable `--log-level debug` and look for messages such as `LDAP search` with the
computed `base` — you will see the per-request base chosen for each SCIM call.
If your token is missing a `name` part, `req.user` will be `"token <index>"`,
which is unlikely to match any map key — always use `id:secret:name`.

## Examples

### Create a User

```bash
curl -X POST http://localhost:8081/scim/v2/Users \
  -H 'Authorization: Bearer my-secret' \
  -H 'Content-Type: application/scim+json' \
  -d '{
    "schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName":"alice",
    "name":{"familyName":"Doe","givenName":"Alice"},
    "emails":[{"value":"alice@example.com","primary":true}]
  }'
```

### PATCH

```bash
curl -X PATCH http://localhost:8081/scim/v2/Users/alice \
  -H 'Authorization: Bearer my-secret' \
  -H 'Content-Type: application/scim+json' \
  -d '{
    "schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations":[
      {"op":"replace","path":"displayName","value":"Alice Doe"}
    ]
  }'
```

### Bulk with `bulkId` cross-reference

```bash
curl -X POST http://localhost:8081/scim/v2/Bulk \
  -H 'Authorization: Bearer my-secret' \
  -H 'Content-Type: application/scim+json' \
  -d '{
    "schemas":["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],
    "Operations":[
      {"method":"POST","bulkId":"u1","path":"/Users",
       "data":{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"alice"}},
      {"method":"POST","path":"/Groups",
       "data":{"schemas":["urn:ietf:params:scim:schemas:core:2.0:Group"],
               "displayName":"admins","members":[{"value":"bulkId:u1"}]}}
    ]
  }'
```

## Error envelope

All errors conform to RFC 7644 §3.12:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "400",
  "scimType": "invalidFilter",
  "detail": "Unknown attribute path 'foo'"
}
```

## Hooks

Other plugins can observe and transform SCIM operations via the dynamic hooks
`scimusercreate`, `scimusercreatedone`, `scimuserupdate`, `scimuserupdatedone`,
`scimuserdelete`, `scimuserdeletedone`, and their `scimgroup*` equivalents, plus
`scimbulkdone` for Bulk.

## Exposing the configuration to client apps (`configApi`)

Load `core/configApi` alongside the SCIM plugin, and `GET /api/v1/config` will
auto-discover SCIM and publish its metadata under `features.scim`. This lets
browser-based editors and dashboards build SCIM-aware UIs without re-parsing
server flags.

```bash
node lib/bin/index.js \
  ... \
  --plugin core/scim \
  --plugin core/static \
  --plugin core/configApi
```

Response shape (truncated):

```json
{
  "apiPrefix": "/api",
  "ldapBase": "dc=example,dc=com",
  "features": {
    "scim": {
      "enabled": true,
      "version": "2.0",
      "prefix": "/scim/v2",
      "endpoints": {
        "users": "/scim/v2/Users",
        "groups": "/scim/v2/Groups",
        "bulk": "/scim/v2/Bulk",
        "serviceProviderConfig": "/scim/v2/ServiceProviderConfig",
        "resourceTypes": "/scim/v2/ResourceTypes",
        "schemas": "/scim/v2/Schemas"
      },
      "schemaUrls": {
        "user": "/static/schemas/scim/User.json",
        "group": "/static/schemas/scim/Group.json",
        "defaultMapping": "/static/schemas/scim/default-mapping.json"
      },
      "capabilities": {
        "patch": true, "bulk": true, "filter": true, "sort": true,
        "etag": false, "changePassword": false,
        "maxResults": 200, "bulkMaxOperations": 100,
        "bulkMaxPayloadSize": 1048576
      },
      "resourceTypes": [
        {
          "id": "User",
          "endpoint": "/scim/v2/Users",
          "schema": "urn:ietf:params:scim:schemas:core:2.0:User",
          "rdnAttribute": "uid",
          "objectClass": ["top", "inetOrgPerson", "organizationalPerson", "person"],
          "filterableAttributes": ["userName", "externalId", "name", "displayName", "...", "id", "active"],
          "mapping": [ /* same shape as default-mapping.json */ ]
        },
        {
          "id": "Group",
          "endpoint": "/scim/v2/Groups",
          "schema": "urn:ietf:params:scim:schemas:core:2.0:Group",
          "rdnAttribute": "cn",
          "mapping": [ /* ... */ ]
        }
      ],
      "idStrategy": "rdn",
      "baseResolution": {
        "userBaseTemplate": "ou=users,ou={user},dc=example,dc=com",
        "groupBaseTemplate": null,
        "hasBaseMap": false
      }
    }
  }
}
```

Notable fields:

- `schemaUrls` — direct download URLs when `core/static` is loaded (editor UIs
  typically fetch them to render attribute pickers).
- `resourceTypes[].mapping` — the live SCIM↔LDAP mapping used server-side, so
  UI builders can render filter helpers / attribute selectors without second
  round-trip.
- `resourceTypes[].filterableAttributes` — the list of attribute paths accepted
  by the SCIM filter parser.
- `baseResolution` — advertises template/map presence but NOT concrete base
  DNs: those vary per authenticated identity and remain server-side.

No configuration is needed on the SCIM plugin to enable this — it advertises
the `configurable` role automatically, and `core/configApi` picks it up.

## Known limitations (v1)

- No `/Me` endpoint (RFC 7644 §3.11).
- ETag / `If-Match` advertised but not enforced.
- No `/.search` POST endpoint (use GET with `?filter=…`).
- `totalResults` is computed from a single LDAP search capped at
  `--scim-max-results`; switch to paged search for directories with many thousands
  of entries.
