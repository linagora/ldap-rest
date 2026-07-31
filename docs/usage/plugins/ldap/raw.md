# LDAP Raw Plugin (low-level browsing)

Read-only, low-level access to the directory itself: root DSE, schema, and entries addressed by their DN. Where the other LDAP plugins expose business objects (users, groups, organizations), this one exposes the tree as it is stored — the server side of a phpLDAPadmin-like interface.

The companion browser library is [`ldap-browser`](../../../client-development/browser/libraries.md#ldapbrowser).

## Features

- **Root DSE**: naming contexts, supported controls and extensions
- **Schema**: object classes, attribute types, syntaxes and matching rules, parsed from the subschema entry (RFC 4512) and cached
- **Entry read**: every attribute, operational ones included, binary values base64-encoded
- **Tree navigation**: direct children of a DN, with an optional "has children" probe
- **Raw search**: arbitrary base, scope and LDAP filter
- **Read-only**: this plugin registers no write route

## Configuration

### Environment Variables

- `DM_LDAP_RAW_BASE`: comma-separated subtrees to expose (default: `--ldap-base`)
- `DM_LDAP_RAW_HIDDEN_ATTRIBUTES`: comma-separated attributes never returned, on top of the credential ones (default: none)
- `DM_LDAP_RAW_SHOW_SECRETS`: serve credential attributes instead of hiding them (default: `false`)
- `DM_LDAP_RAW_MAX_RESULTS`: maximum entries returned by a search or a children listing (default: `200`)
- `DM_LDAP_RAW_SCHEMA_CACHE_TTL`: schema cache lifetime in seconds (default: `3600`)

### Command Line

```bash
ldap-rest \
  --plugin core/ldap/raw \
  --ldap-raw-base "ou=users,dc=example,dc=com" \
  --ldap-raw-base "ou=groups,dc=example,dc=com" \
  --ldap-raw-hidden-attribute employeeNumber \
  --ldap-raw-max-results 500
```

With no `--ldap-raw-base`, the plugin exposes `--ldap-base`.

## API Endpoints

```
GET /api/v1/ldap/raw/bases          # Exposed subtrees (roots of the tree)
GET /api/v1/ldap/raw/rootdse        # Server capabilities
GET /api/v1/ldap/raw/schema         # Parsed directory schema
GET /api/v1/ldap/raw/entry/{dn}     # One entry, operational attributes included
GET /api/v1/ldap/raw/children/{dn}  # Direct children of an entry
GET /api/v1/ldap/raw/search         # Arbitrary search
```

`{dn}` is the URL-encoded fully-qualified DN.

### Entry format

Attribute values are always arrays. A `binary` flag tells whether the values are base64-encoded octets rather than text:

```json
{
  "dn": "uid=alice,ou=users,dc=example,dc=com",
  "attributes": {
    "objectClass": { "values": ["top", "inetOrgPerson"], "binary": false },
    "uid": { "values": ["alice"], "binary": false },
    "cn": { "values": ["Alice Smith"], "binary": false },
    "jpegPhoto": { "values": ["/9j/4AAQSkZJRg…"], "binary": true }
  }
}
```

A value is flagged binary when the directory returned octets that are not valid UTF-8, or when the attribute type is binary.

Credential attributes are **not** part of the response by default — see [Hidden attributes](#hidden-attributes).

### Children

```bash
curl "$URL/api/v1/ldap/raw/children/$(urlencode 'dc=example,dc=com')?children=1"
```

```json
{
  "children": [
    {
      "dn": "ou=users,dc=example,dc=com",
      "rdn": "ou=users",
      "objectClass": ["organizationalUnit"],
      "hasChildren": true
    }
  ],
  "truncated": false
}
```

`hasChildren` is only computed when the `children` query parameter is set: it costs one extra search per child.

At most `--ldap-raw-max-results` children are returned. `truncated` is true when the branch holds more, so a browsing UI can say so instead of silently showing a partial list — a branch of 5000 users must not look like a branch of 200.

### Search

| Parameter    | Default                  | Description                                    |
| ------------ | ------------------------ | ---------------------------------------------- |
| `base`       | first exposed base       | Search base, must be inside an exposed subtree |
| `scope`      | `sub`                    | `base`, `one` or `sub`                         |
| `filter`     | `(objectClass=*)`        | LDAP filter                                    |
| `attributes` | `*`                      | Comma-separated attribute list                 |
| `limit`      | `--ldap-raw-max-results` | Capped by `--ldap-raw-max-results`             |

```bash
curl "$URL/api/v1/ldap/raw/search?base=ou=users,dc=example,dc=com&filter=(mail=*@example.com)&attributes=uid,mail"
```

```json
{ "entries": [...], "truncated": false }
```

`truncated` is true when the limit cut the result set short.

The filter is parsed before the search runs, so a malformed one comes back as a 400 naming it rather than as a server error — a search box receives whatever the user typed, and `gov` is a typo, not a server fault:

```json
{
  "error": "Invalid LDAP filter \"gov\": Invalid expression: gov. A filter must be parenthesised, e.g. (cn=foo) or (|(cn=*foo*)(ou=*foo*))"
}
```

### Schema

```json
{
  "objectClasses": [
    {
      "oid": "2.5.6.6",
      "names": ["person"],
      "desc": "RFC2256: a person",
      "kind": "STRUCTURAL",
      "sup": ["top"],
      "must": ["sn", "cn"],
      "may": ["userPassword", "telephoneNumber", "seeAlso", "description"],
      "obsolete": false
    }
  ],
  "attributeTypes": [
    {
      "oid": "2.5.4.3",
      "names": ["cn", "commonName"],
      "sup": "name",
      "singleValue": false,
      "noUserModification": false,
      "usage": "userApplications",
      "obsolete": false,
      "collective": false
    }
  ],
  "syntaxes": [...],
  "matchingRules": [...]
}
```

Inheritance is **not** flattened: a client resolving the attributes of an entry must walk the `sup` chains. `SchemaView` (browser) and `SchemaIndex` (`src/lib/ldapSchema.ts`, server) do it for you.

## Hidden attributes

Attributes holding credential material are stripped from **every** response — entry reads and searches alike — before it leaves the server. Asking for one explicitly (`?attributes=uid,userPassword`) does not get around the filter: the removal happens when the entry is serialised, not when the query is built.

The built-in list covers the usual OpenLDAP, Samba, Kerberos and Active Directory spellings:

```
userPassword, authPassword, pwdHistory, sambaNTPassword, sambaLMPassword,
sambaPasswordHistory, krbPrincipalKey, krbExtraData, krbPwdHistory,
unicodePwd, dbcsPwd, lmPwdHistory, ntPwdHistory, supplementalCredentials,
userPKCS12
```

A password hash served over HTTP is an offline cracking target, and browsing a directory does not require reading one — hence hidden by default, visible only on request:

```bash
--ldap-raw-show-secrets true    # logs a warning at startup
```

Site-specific attributes are added with `--ldap-raw-hidden-attribute`, which stacks on top of the built-in list rather than replacing it:

```bash
--ldap-raw-hidden-attribute twakeApiKey --ldap-raw-hidden-attribute employeeNumber
```

Note that hiding an attribute here keeps it out of the API, not out of the directory: an account able to bind to LDAP directly still reads it. This is a guard against casual exposure through the browsing UI, not an access control — use [authz-per-branch](../auth/authz-per-branch.md) or directory ACLs for that.

## Security

Access is restricted in three independent layers:

1. **Exposed bases** — any DN outside `--ldap-raw-base` is refused with a 403, whatever the caller's rights.
2. **Authorization hooks** — every entry read, children listing and search goes through `server.ldap`, so the authorization plugins ([authz-per-branch](../auth/authz-per-branch.md), authz-dynamic, …) apply exactly as on the high-level APIs.
3. **Hidden attributes** — credential attributes, plus anything in `--ldap-raw-hidden-attribute`, are removed from every response, including searches. See [Hidden attributes](#hidden-attributes).

Two exceptions, both deliberate: the **root DSE** and the **schema** are read with the service account, not with the caller's rights. They are directory metadata and carry no user data; reading them with a restricted account would leave the UI unable to name and type attributes. Do not expose this plugin publicly if your directory publishes sensitive information in its root DSE.

Combine with an authentication plugin ([token](../auth/token.md), [oidc](../auth/oidc.md), …) — this plugin adds no authentication of its own.

## How It Works

- **Schema fetch**: the root DSE is read for `subschemaSubentry` (falling back to `cn=Subschema`), then the subschema entry is fetched and parsed once per `--ldap-raw-schema-cache-ttl`. Concurrent callers share a single fetch.
- **Operational attributes**: entries are read with `*` and `+`. When the server rejects `+`, the read is retried with `*` alone.
- **Missing entries**: the LDAP "no such object" result (code 32) is mapped to a 404.

## Limitations

- **Read-only.** Creating, modifying, renaming and deleting entries is not exposed yet.
- **No LDIF** import or export.
- **No paging**: searches and children listings are capped by `--ldap-raw-max-results` and flagged as `truncated`; there is no cursor to fetch the rest. Use a narrower search to reach entries beyond the cap.

## Usage Example

```bash
ldap-rest \
  --plugin core/auth/token --auth-token "$TOKEN" \
  --plugin core/ldap/raw \
  --plugin core/static
```

The demo page ([`examples/web/ldap-browser.html`](../../../../examples/web/ldap-browser.html)) is then served at
`/static/examples/web/ldap-browser.html`.

## See Also

- [ldap-browser client library](../../../client-development/browser/libraries.md#ldapbrowser)
- [organizations plugin](organizations.md) — high-level tree of organizational units
- [authz-per-branch plugin](../auth/authz-per-branch.md) — branch-level access control
