# Upgrading

What to check before deploying, newest first. Only releases that need a
decision or a configuration change appear here; see the
[CHANGELOG](../../CHANGELOG.md) for everything else.

## To 0.8.0

### Node 22 is the floor

**Who is affected:** anyone installing on Node 20 or older.

`engines` declares `>=22`, and the CI runs the suite on 22, 24 and 26. Older
runtimes are not tested and not supported.

### The Twake schemas now need `core/ldap/enterpriseRules`

**Who is affected:** every deployment loading `static/schemas/twake/*`.

Those schemas mark `twakeDepartmentPath`, `twakeAccountStatus` and
`twakeDeliveryMode` both `required` and `generated` — a client may not send
them, and a plugin has to fill them. Load the one that does:

```bash
--plugin core/ldap/enterpriseRules
```

Without it, a creation answers `400` naming the attribute, on the flat routes
as on `POST /ldap/organizations` and `POST /ldap/groups`. That refusal is
deliberate: the previous release wrote the entry anyway, missing an attribute
its own schema called required and that no client could ever add.

**The nomenclature has to hold what the schema defaults name.** The user
schema points at `cn=normal,ou=twakeDeliveryMode,ou=nomenclature,<base>` and
`cn=active,ou=twakeAccountStatus,ou=nomenclature,<base>`. A directory never
seeded with those entries answers `400` on every creation, naming the DN that
does not resolve — rather than storing a dangling one on each account.

### Clients must stop sending the computed attributes

**Who is affected:** anything that creates or updates users, groups or
organizations against the Twake schemas.

`uid` (generated from the local part of `mail`), `twakeDepartmentPath`,
`twakeAccountStatus` and `twakeDeliveryMode` are refused in a request body
with a `400` naming the attribute. Drop them from the payload — the server
fills them.

To keep the old behaviour, copy the schema and remove the markers: each of
these is a `generated` or `readOnly` flag in the JSON, not code.

### Run the audit before switching

**Who is affected:** every directory holding entries written before this
release.

```bash
npm run audit:directory -- --schema static/schemas/twake/users.json
```

It reads the branch as it stands and reports what the schema would now refuse,
quoting each rule's own `hint`. Two rules tightened in ways that only show on
stored data:

- an array's `items.test` and `items.branch` are enforced on the flat routes,
  where they never were — `mailAlternateAddress` has carried a pattern since
  0.7.0 and accepted anything;
- a pointer's `branch` is compared RDN by RDN. A DN that merely ended with the
  branch as text, `uid=x,xou=users,dc=example,dc=com` against
  `ou=users,dc=example,dc=com`, used to pass.

Stored values are left alone. The refusal comes at the next update of an
offending entry, which is why it is worth knowing beforehand.

### A flat schema may not claim a URL an LDAP plugin serves

**Who is affected:** anyone passing `--ldap-flat-schema` a schema whose
`entity.pluralName` is `groups`, `organizations`, `raw` or `bulk-import`
beside the plugin of the same name — `static/schemas/twake/groups.json` is
exactly that.

Both used to load, sharing a hook prefix and a URL; Express answered with
whichever registered first, and the loser stayed advertised by the
configuration API while being unreachable in fact. The schema is now dropped
with an error naming the holder. **Load one or the other, not both.**

### Organization paths: nothing to convert

**Who is affected:** directories written before the path order was settled.

`twakeDepartmentPath` reads from the root down, the entry's own name last.
What is already stored in the old order — the entry's own name first, the top
organization's last — is still accepted as it stands, so no organization
becomes unwritable on upgrade. Only paths the server computes from now on
follow the new order, and the two forms coexist until an entry is rewritten.

## To 0.7.0

### `externalId` on Groups is no longer served

**Who is affected:** anyone provisioning Groups from an identity provider and
reading `externalId` back, or filtering on it.

A Group's `externalId` used to answer its `entryUUID`. RFC 7643 section 3.1
makes `externalId` the _provisioning client's_ identifier, so the id Okta or
Entra ID sent was discarded on write, and `filter=externalId eq "<their id>"`
searched `entryUUID` and matched nothing.

Name an attribute to store it in:

```bash
--scim-group-external-id-attribute description
```

Left unset, `externalId` is simply not supported on Groups — absent from
answers, and refused in filters. That is the honest behaviour; the previous
one looked like support and was not.

Users are unaffected: theirs was already stored in `employeeNumber`.

**Migrating existing Groups.** Values sent before this release were never
stored, so there is nothing to convert — re-send them from the provisioning
side once the flag is set.

### `active` is now writable, and needs an attribute your directory holds

**Who is affected:** every SCIM deployment. Deactivations that used to be
silently dropped now reach the directory.

`active` is modelled on the presence of one LDAP attribute:

```bash
--scim-user-lock-attribute pwdAccountLockedTime   # default
--scim-user-lock-value     000001010000Z          # default, "locked forever"
```

The default is the ppolicy overlay's convention, and **`pwdAccountLockedTime`
only exists where slapd loads that overlay**. On a directory without it —
plain OpenLDAP, 389-ds, AD — a deactivation is refused by the schema and
answers `400 invalidValue` naming the flags. Point them elsewhere:

```bash
--scim-user-lock-attribute nsAccountLock
--scim-user-lock-value     TRUE
```

Two configuration mistakes are now refused at startup rather than accepted
and silently ineffective: naming an attribute without a value, and a name
that is not an LDAP attribute description. Two more are warned about. See
[the SCIM plugin documentation](plugins/integrations/scim.md#deactivating-an-account-active) for the
detail.

**Verify once, by hand, that a deactivation actually prevents a bind.**
Nothing here can check that your directory honours the value you chose:
`active` is read back from the mere presence of the attribute, so a value the
directory stores and ignores still reads as `false`.

**One deliberate deviation from RFC 7644 section 3.5.1:** a `PUT` that omits
`active` leaves the lock as it stands rather than clearing it. Clearing it
would release locks SCIM never set — a ppolicy auto-lockout after failed
binds, or one an administrator placed — so a routine profile sync would
defeat the brute-force control. Send `"active": true` to reactivate
deliberately.

### `forRequest()` for plugin authors

No action needed to upgrade. If you maintain a plugin that serves HTTP
requests, `this.server.ldap.forRequest(req)` returns a directory whose methods
carry the request, so the authorization hooks always see it. The unbound
methods take the request as a trailing optional argument, and omitting it
skips every authorization check silently. See the
[plugin development guide](../plugin-development/README.md#using-ldap-operations).

## To 0.6.2

### Writes that a bypass was letting through are now refused

**Who is affected:** deployments using `core/auth/authzPerBranch` or
`core/auth/authzLinid1` together with `plugins/ldap/onChange` or
`plugins/ldap/organizations`.

Both plugins rebuilt the hook tuple without the request, which made every
authorization plugin registered after them skip its check. Every `modify`,
and every `rename` for the second, went through unchecked.

**Check your grants before rolling this out widely.** An identity whose
grants were never quite right may start seeing `403` where it saw `200`. That
is the fix, not a regression.

Whether a given deployment was exposed was decided by plugin load order,
which is a race — it could differ from one restart to the next.
`core/auth/authzDynamic` was never affected: it reads its token from an
`AsyncLocalStorage` rather than from the request.

## To 0.6.1

### SCIM reads are authorized

**Who is affected:** any SCIM identity granted `write` without `read` on the
same branch.

Every search the SCIM plugin issued omitted the request, so
`ldapsearchrequest` — the hook the authorization plugins use — skipped its
check, and any authenticated identity could read any branch the plugin was
pointed at.

**An identity that writes now needs `read` on the same branch.** A SCIM write
answers with the resource it just changed, so it reads the entry back; a
grant of `write` without `read` no longer serves a write.

`GET /Users`, `GET /Users/{id}` and their Group counterparts answer `403`
where read is denied.
