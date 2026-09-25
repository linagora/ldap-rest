# LDAP onChange Plugin

Publish the state of an entry before and after each write made through
LDAP-Rest, and hooks for the attributes other plugins follow.

## Configuration

```bash
--plugin core/ldap/onChange \
--mail-attribute mail \
--quota-attribute mailQuota
```

## Hooks

`onLdapEntryChange(dn, before, after, context)` fires after every add,
modify, rename and delete, with the entry as the directory held it on each
side:

| Operation | `before`                 | `after`                  |
| --------- | ------------------------ | ------------------------ |
| add       | `null`                   | the new entry            |
| modify    | the entry before         | the entry after          |
| rename    | the entry, at its old DN | the entry, at its new DN |
| delete    | the entry before         | `null`                   |

`dn` is the entry's DN after the write, its old one on a delete. `context`
says who made the write, and through which door:

- `actor`: the caller's `userName`, or its `user` when it has none;
- `requestId`: generated, the same for every write of one request;
- `source`: `scim` for the SCIM API, `rest` otherwise.

A write no request is behind, such as a scheduled task's, gets `{}`. The LDAP
`ldap*done` hooks receive the same context after their arguments.

The other hooks are derived from it:

| Hook                      | Fires when                                                 | Parameters                             |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| `onLdapChange`            | any attribute changed                                      | `(dn, changes)`                        |
| `onLdapMailChange`        | `--mail-attribute` changed                                 | `(dn, oldMail, newMail)`               |
| `onLdapQuotaChange`       | `--quota-attribute` changed                                | `(dn, mail, oldQuota, newQuota)`       |
| `onLdapAliasChange`       | `--alias-attribute` changed                                | `(dn, mail, oldAliases, newAliases)`   |
| `onLdapForwardChange`     | `--forward-attribute` changed                              | `(dn, mail, oldForwards, newForwards)` |
| `onLdapDriveQuotaChange`  | `--drive-quota-attribute` changed                          | `(dn, oldQuota, newQuota)`             |
| `onLdapDisplayNameChange` | the name built from `cn`, or `givenName` and `sn`, changed | `(dn, oldName, newName)`               |

`changes` maps each attribute that changed to `[oldValues, newValues]`, the
full values on each side, `null` where the attribute is absent:

```text
member was [a, b], the request added c:
{ member: [['a', 'b'], ['a', 'b', 'c']] }
```

## What counts as a change

Values are compared as sets: a single value and a one-element array are equal,
and so are two orderings of the same values. A write that leaves every value
as it was, such as a `replace` with the current value, fires no hook.

## Timing and errors

Hooks run after the directory has accepted the write, and the API answers
without waiting for them. A hook that throws is logged; the write stays.

## Limitations

- Only writes made through LDAP-Rest are seen; a direct LDAP client's are not.
- Entries moved by the [trash](trash.md) plugin are not seen, nor the entries
  under a renamed container, which move with it.
- Each write reads the entry before and after it: one search on each side.
