# LDAP Enterprise Rules Plugin

The business rules an enterprise directory needs on top of per-attribute
validation: uniqueness across a shared namespace, mail addresses confined to
the domains an organization owns, computed organization paths, normalised
quotas, and referential-integrity guards on deletion.

Every rule is driven by the loaded entity schemas. The plugin contains no
attribute name, no domain and no nomenclature value, so the same code serves a
directory laid out differently without a change.

## Configuration

```bash
--plugin core/ldap/enterpriseRules
```

It reads the schemas already loaded by `core/ldap/flatGeneric`,
`core/ldap/groups` and `core/ldap/organizations`, so load it alongside them.
The organizations plugin only exposes its schema when one is given:

```bash
--organization-schema ./static/schemas/twake/organizations.json
```

| Option                               | Default             | Purpose                                                             |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------- |
| `--enterprise-domain-name-attribute` | `associatedDomain`  | Attribute holding the mail domain of a domain entry                 |
| `--enterprise-domain-link-attribute` | _(from the schema)_ | Fallback when the organization schema declares no `domainLink` role |
| `--group-dummy-user`                 | `cn=fakeuser`       | Placeholder member that does not count towards `deleteGuard`        |

## Order of evaluation

Checks run **before** transformations, inside the same hook. A check therefore
always sees the payload as the client sent it: uniqueness and domain rules
validate the address that was submitted, never one the server has already
rewritten, and an identifier derived from that address cannot influence the
check that justified it.

## Rules

### Uniqueness

```json
{
  "employeeNumber": { "type": "string", "unique": true },
  "mail": {
    "type": "string",
    "role": "primaryEmail",
    "unique": {
      "attributes": ["mailAlternateAddress"],
      "branches": ["dc=example,dc=com"]
    }
  }
}
```

- `attributes` names the other attributes sharing the value namespace — a mail
  address must not already be someone's alias.
- `branches` widens the search beyond the entity's own branch, which is what
  makes an address unique across accounts _and_ distribution lists.
- `sentinel` exempts one value, for directories that use a placeholder on
  non-individual entries.
- `filter` narrows the search, e.g. `(objectClass=twakeAccount)`.

On an update the entry being modified is excluded from the search, so
re-sending an unchanged value never conflicts with itself.

### Mail domains

```json
{
  "mail": {
    "mailDomainScope": "organization",
    "allowSubdomains": true
  }
}
```

`organization` walks up from the entry's `organizationLink`, collecting the
domains each ancestor declares through its `domainLink` role, up to the root of
the tree. `directory` accepts any domain declared anywhere. When nobody
declares a domain, no restriction applies; a domain entry whose name is `*`
authorises every domain.

The host is taken after the **last** `@`, so a domain that merely ends with an
authorised one (`evil-example.org` against `example.org`) is refused.
`allowSubdomains` is what lets a distribution list live at
`all@lists.example.org` under an organization that owns `example.org`.

### Computed organization path

An entity declaring both an `organizationLink` and an `organizationPath` role
gets its path filled from the organization it points at, on creation and
whenever the link changes. Mark the path `generated` so a client cannot set it.

### Normalised sizes

```json
{
  "mailQuotaSize": {
    "type": "number",
    "normalize": "byteSize",
    "default": 1000000000,
    "hint": "Expected pattern xGB, xMB, xKB or a number of bytes"
  }
}
```

`5GB`, `500 MB`, `2KB` and `2048` all become a number of bytes, with decimal
multipliers (1 GB = 10⁹ bytes) as mail servers count them. The same conversion
applies to creations and to updates.

### Server-owned defaults

On creation, an attribute that is `generated` or `normalize`d and carries a
`default` is filled when the client said nothing — which is how a new account
lands in its initial state:

```json
{
  "twakeAccountStatus": {
    "type": "pointer",
    "role": "accountStatus",
    "generated": true,
    "default": "cn=active,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"
  }
}
```

### Scheduled removal

An `accountExpiry` attribute must not carry a date already past. The comparison
is against the start of the current day, so scheduling something for today is
allowed.

### Deletion guards

```json
{
  "title": { "type": "pointer", "referentialIntegrity": "restrict" },
  "member": { "type": "array", "role": "members", "deleteGuard": "nonEmpty" }
}
```

- `referentialIntegrity: "restrict"` refuses to delete an entry while another
  entry still points at it — a position somebody still holds, a nomenclature
  value still in use. Declared on the **referencing** attribute, and the
  pointer's `branch` tells the plugin which deletions to check.
- `deleteGuard: "nonEmpty"` refuses to delete a group that still has members.
  The placeholder member some directories keep to satisfy `groupOfNames`
  (`--group-dummy-user`) does not count.

Both default to off: a deployment turns them on where it wants them.

## Errors

| Status | When                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| `400`  | A size that is not a size, a date already past                                |
| `409`  | A duplicate value, a mail domain outside the authorised set, a guarded delete |

## See also

- [flat-generic](flat-generic.md) — the schema format these markers extend
- [account-lifecycle](account-lifecycle.md) — status changes and password resets
- [organizations](organizations.md) — the tree the domain rule walks up
