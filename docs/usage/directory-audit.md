# Auditing a directory before a migration

Tightening a validation pattern changes what the server accepts **from now
on**. It says nothing about the entries already stored: a directory whose
addresses were never anchored, or whose organization names predate the rule
that now governs them, loads fine and then refuses the first update of every
offending entry — which is discovered one support ticket at a time.

`npm run audit:directory` reads a branch as it is and reports what the schema
would refuse, so the work is known before the switch rather than after it.

## Running it

```sh
export DM_LDAP_URL=ldap://directory.example.org
export DM_LDAP_DN='cn=admin,dc=example,dc=com'
export DM_LDAP_PWD='…'
export DM_LDAP_BASE='dc=example,dc=com'

npm run audit:directory -- --schema static/schemas/twake/users.json
```

| Option            | Default                      | Purpose                             |
| ----------------- | ---------------------------- | ----------------------------------- |
| `--schema`        | _(required)_                 | Schema to check against             |
| `--base`          | the schema's own entity base | Branch to read                      |
| `--filter`        | `(objectClass=*)`            | Narrows what is audited             |
| `--url`           | `DM_LDAP_URL`                | Directory to read                   |
| `--bind-dn`       | `DM_LDAP_DN`                 | Identity to read with               |
| `--bind-password` | `DM_LDAP_PWD`                | Its password                        |
| `--samples`       | `5`                          | Offending entries named per finding |

It exits `0` when the branch is clean, `1` when the schema would refuse
something, and `2` when the audit itself could not run — an unreadable schema,
a directory that would not answer — so a pipeline can tell "dirty" from
"broken" rather than gating on both alike.

`--bind-password` puts the password in `ps` and in the shell history of
whoever runs it. `DM_LDAP_PWD` is the path to prefer, and the flag is there
for parity with the server's own `--ldap-pwd`.

## What it checks, and what only the server can

The audit reads a schema and an entry, so it answers what an entry alone can
answer: required attributes, the `test` pattern of a value and of an array's
elements, and the branch a DN must land in. It replaces `__KEY__` placeholders
and `{config_key}` in `entity.base` from the `DM_*` environment exactly as the
server does, leaving a placeholder the configuration does not name.

What it does not answer needs the rest of the directory, and belongs to a dry
run rather than here: uniqueness across a namespace, the mail domains an
organization owns, and anything a plugin computes after validation. A clean
audit is not a promise that every entry will survive every rule — it is a
promise that none of them fails on its own contents.

## Reading the report

```
12632 entries read, 47 value(s) the schema would refuse:

  mail: does not match — 41
    expected: Expected an address in the example.org domain, at most 64 characters before the @
    uid=jean.dupont,ou=users,dc=example,dc=com → "jean.dupont@old-domain.example"
    …and 36 more

  postalCode: does not match — 6
    expected: Expected pattern 9999, A9999 or R9999
    uid=marie.martin,ou=users,dc=example,dc=com → "1234"
```

Each finding names the attribute, why it was refused, and — from the schema's
`hint` — what a valid value looks like. The same wording reaches the person
filling the form, so the fix and the rule are described identically.

## What it checks, and what it cannot

Checked, because an entry answers for itself:

- `test` patterns, on single and multi-valued attributes
- `required` attributes that are absent — except the ones the server computes
  (`generated`), which an entry is not expected to carry yet
- the `branch` a `pointer` must land in

Not checked, because it takes the whole directory or a live server:

- uniqueness across a shared namespace
- mail addresses against the domains an organization owns
- anything a hook computes rather than validates

For those, run the target configuration against a copy of the directory and
replay the writes.

## See also

- [flat-generic](plugins/ldap/flat-generic.md) — where `test` and `hint` live
- [enterprise-rules](plugins/ldap/enterprise-rules.md) — the rules a dry run covers
