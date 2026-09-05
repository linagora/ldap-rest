# LDAP Account Lifecycle Plugin

The two account operations an administrator performs most often — change an
account's state, and reset its password — as first-class endpoints.

Both are expressed against semantic roles, never attribute names. What
"disabled" _is_ in a given directory — a DN in a nomenclature, a string, a
boolean — is schema configuration.

## Configuration

```bash
--plugin core/ldap/accountLifecycle
```

The plugin loads `core/ldap/flatGeneric` if it is not already there, and adds
endpoints to each entity whose schema asks for them:

- `POST /api/v1/ldap/{pluralName}/{id}/status` when the schema declares an
  `accountStatus` attribute carrying named `states`
- `POST /api/v1/ldap/{pluralName}/{id}/password` when it declares a `password`
  attribute

Changes go through the entity's own modify path, so schema validation, hooks
and authorization apply exactly as they do to any other update.

## Declaring the states

```json
{
  "twakeAccountStatus": {
    "type": "pointer",
    "branch": ["ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"],
    "role": "accountStatus",
    "generated": true,
    "default": "cn=active,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com",
    "states": {
      "enabled": "cn=active,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com",
      "disabled": "cn=disabled,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com",
      "noAccess": "cn=noaccess,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com",
      "toDelete": "cn=todelete,ou=twakeAccountStatus,ou=nomenclature,dc=example,dc=com"
    }
  }
}
```

`enabled` and `disabled` are the names the API speaks; a deployment adds its
own freely. `default` is what a new account gets, applied by
[enterprise-rules](enterprise-rules.md).

## Changing the state

```bash
curl -X POST http://localhost:8081/api/v1/ldap/users/alice/status \
  -H 'Content-Type: application/json' \
  -d '{"state": "disabled"}'
```

```json
{ "success": true, "state": "disabled" }
```

An unknown state is refused with a `400` that names the ones this directory
knows, so a client never has to hardcode the list:

```json
{
  "error": "Unknown state \"retired\" for user; known states: enabled, disabled, noAccess, toDelete"
}
```

## Resetting the password

```bash
curl -X POST http://localhost:8081/api/v1/ldap/users/alice/password \
  -H 'Content-Type: application/json' -d '{}'
```

```json
{ "success": true, "generated": true, "forceChange": true, "password": "xY3k…" }
```

With no `password` in the body, one is generated and returned **once** — the
credential attributes are marked `neverReturn` in the schema precisely so a
later read cannot hand it back. Supply `password` to set a chosen one; the
answer then carries `"generated": false` and does not echo it.

A `password` that is present has to be a non-empty string. An empty one — or
`null`, or anything that is not text — is refused with a `400`:

```json
{
  "error": "Field password must be a non-empty string; omit it to have one generated"
}
```

It used to be taken as an absent one, so `{"password": ""}` answered
`success` after setting a random credential the caller never saw: a client
that emptied the field by accident believed it had set the password it typed.
Omitting the field is how a generated password is asked for.

`forceChange` (true by default) also writes the `passwordReset`-role attribute
so the directory asks for a new password at next login. For a boolean
attribute the values written are `TRUE` and `FALSE`; a directory that spells
them otherwise says so through `states.required` and `states.cleared`.

| Field         | Meaning                                             |
| ------------- | --------------------------------------------------- |
| `generated`   | The server chose the password                       |
| `password`    | Present only when generated                         |
| `forceChange` | Whether the "change at next login" flag was written |

> **Note** — `pwdReset` is an operational attribute of the OpenLDAP `ppolicy`
> overlay. Writing it requires the overlay to be loaded; without it the
> directory answers `attribute type undefined`.

## Errors

| Status | When                                                           |
| ------ | -------------------------------------------------------------- |
| `400`  | Unknown state, or a body with no `state`                       |
| `400`  | A `password` that is present but empty, `null` or not a string |
| `404`  | No such account                                                |

## See also

- [flat-generic](flat-generic.md) — `role`, `states` and `neverReturn`
- [enterprise-rules](enterprise-rules.md) — the default state of a new account
- [password-policy](password-policy.md) — expiry, lockout and complexity
