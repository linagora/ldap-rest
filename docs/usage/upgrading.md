# Upgrading

What to check before deploying, newest first. Only releases that need a
decision or a configuration change appear here; see the
[CHANGELOG](../../CHANGELOG.md) for everything else.

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
