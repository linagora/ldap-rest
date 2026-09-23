# Upgrading

What to check before deploying, newest first. Only releases that need a
decision or a configuration change appear here; see the
[CHANGELOG](../../CHANGELOG.md) for everything else.

## Unreleased

### `/subnodes/search` caps what it returns

**Who is affected:** a client reading the whole answer of
`/api/v1/ldap/organizations/<dn>/subnodes/search` and expecting every match.

It returned every attached entry it found, which is the one shape a directory
with a size limit cannot answer: past that limit the server refuses the
search rather than shortening it. It now caps them at
`--ldap-organization-max-subnodes` (default 50) and ends the list with the
`moreIndicator` row `/subnodes` already used, so the two endpoints answer the
same shape.

A client that treats every row as an entry will show that row as one. Drop
whatever carries `_isMoreIndicator` — see
[the endpoint's notes](plugins/ldap/organizations.md#get-organization-subnodes).

The same row can now also appear among the **child organizations**, which
were never capped and still are not: it says the directory refused to list
them all, and it carries no `_totalCount`, nothing having counted them.

### `/subnodes/search` is authorized, and lists the children by page

**Who is affected:** anyone whose callers reach that route with a token that
does not hold the whole directory, and anyone running against Active
Directory.

Neither of its searches carried the request, and an authorization plugin
skips its check when there is none — the same gap the flat routes had until
0.8.2. A caller now sees what its branch grants it, where it used to see
everything the directory held; a caller outside its branch is refused. This
is a fix, but it changes what an existing client receives.

The child organizations of both routes are also searched by page now. On
OpenLDAP that changes nothing — the server's size limit bounds a paged
search as it does an unpaged one. On **Active Directory** it does: an
unpaged search answered at most `MaxPageSize` entries (1000 by default) and
said nothing about the rest, so a node with more children than that now
returns all of them, and a client holding the answer in memory receives a
larger one than before.

### Back-Channel Logout keeps its marks in `core/storage`

`core/bcl/ldap` and `core/bcl/file` are gone, and with them
`--bcl-ldap-base`, `--bcl-ldap-object-class`, `--bcl-file-directory` and
`--bcl-sweep-interval`. One plugin, `core/bcl`, keeps what a logout killed in
`core/storage`, so a deployment chooses where records live once and every
consumer of that store follows. Sweeping is now `--storage-sweep-interval`;
`--bcl-retention` stays, because how long a mark is kept is Back-Channel
Logout's policy rather than the store's. See
[Storage](plugins/utilities/storage.md) and
[Back-Channel Logout](plugins/auth/back-channel-logout.md).

**Marks written before this are not read.** The key is namespaced now, and
the LDAP branch is the store's rather than the plugin's. Back-Channel Logout
shipped in no release — 0.8.2 predates it — so this can only affect an
instance running a build from `master`. If yours is one, everything logged out
within the retention window stops counting once you upgrade, and the old
`ou=BclTombstones` branch, or the old `--bcl-file-directory`, is left behind
for you to remove.

### Judging an account by what it is attached to

`--authz-filter-attached-entries` changes what a branch grant means, so it is
off by default and nothing moves until you set it.

Every account of a directory lives in the same `ou=users`, so a branch check
on its parent says the same thing about all of them: either every
administrator reaches every account, or none does. With the option on, an
account is judged by the organization its `twakeDepartmentLink` names —
listings drop the accounts attached elsewhere, and a write is refused on an
account outside the branch you hold. Entries attached to nothing, which is
what an organization or a nomenclature value is, stay readable by every
administrator.

**Turn it on only where a branch is a department.** Where a branch is a
tenant, the option also stops refusing a read on the branch it targets — the
organization tree and the reference data become readable across branches, and
what keeps one customer out of another's data is then the per-entry filter
alone.

It is honoured by `core/auth/authzPerBranch` and `core/auth/authzLinid1`.
`core/auth/authzDynamic` registers its own hooks and never sees the filter:
setting the option there does nothing at all.

## To 0.8.0

### Node 20 is the floor

**Who is affected:** anyone installing on Node 18 or older.

`engines` declares `>=20` — the version Debian 13 ships — and the CI runs the
suite on 20, 22, 24 and 26. Older runtimes are neither tested nor supported.

**`core/auth/llng` is the one plugin that does not follow.** It needs
`lemonldap-ng-handler`, which depends on the native `re2`, and no single `re2`
release installs on every supported Node: up to `1.24.0` it builds on 20 but
not on 26, and from `1.24.1` it declares `engines: >=22`. npm answers an
unsatisfied dependency of this kind by leaving an _optional_ package out
without a word, so on some runtimes the handler is simply absent.

Everything else builds, tests and runs there regardless. A server that
configures `core/auth/llng` on a runtime where the handler could not be
installed now fails at startup, naming the plugin and the missing package,
rather than accepting requests an authentication plugin cannot check. Check
after upgrading that the runtime you deploy on carries it:

```bash
node -e "require('lemonldap-ng-handler'); console.log('present')"
```

### The LLNG handler now needs a working configuration at startup

**Who is affected:** every deployment configuring `core/auth/llng`.

The handler used to do nothing at startup: `--llng-ini` was read into the
configuration but never handed to it, so every request failed with a `500`
regardless of what the file said. It is now initialized once, before the
server starts serving — which means the file finally matters, and two ways
it can be wrong now stop the server instead of answering `500`:

- `--llng-ini` defaults to `/etc/lemonldap-ng/lemonldap-ng.ini`, and a file at
  that path with no `[node-handler] nodeVhosts` listing this server — the
  normal state until now, since nothing read it — refuses to start where it
  used to start and answer `500` to every request instead;
- an LLNG configuration store (`[configuration] baseConfigUrl` and the rest)
  unreachable when the server boots crash-loops it under an orchestrator,
  until the portal or config store it depends on comes up.

List this server before upgrading:

```ini
[node-handler]
nodeVhosts = api.example.com
```

and, if the LLNG configuration store starts after this server does, sequence
the two or give the container a restart policy that tolerates a few
failures at boot.

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
npm run audit:directory -- --schema static/schemas/twake/users.json \
  --plugin core/ldap/enterpriseRules
```

It reads the branch as it stands and reports what the schema would now refuse,
quoting each rule's own `hint`. Two rules tightened in ways that only show on
stored data:

- an array's `items.test` and `items.branch` are enforced on the flat,
  organization and group routes, where they never were —
  `mailAlternateAddress` has carried a pattern since 0.7.0 and accepted
  anything — and an array of pointers must name existing entries;
- a pointer's `branch` is compared RDN by RDN. A DN that merely ended with the
  branch as text, `uid=x,xou=users,dc=example,dc=com` against
  `ou=users,dc=example,dc=com`, used to pass.

Stored values are left alone. The refusal comes at the next update of an
offending entry, which is why it is worth knowing beforehand.

### `employeeNumber` is unique, apart from the `UNIT` placeholder

**Who is affected:** directories where accounts share a placeholder employee
number other than `UNIT`.

`static/schemas/twake/users.json` declares `employeeNumber` unique, exempting
the value `UNIT` — the placeholder the interface these schemas replace uses
for an account standing for a unit rather than a person. Once
`core/ldap/enterpriseRules` is loaded, every creation or update carrying a
value another account already holds answers `409`; `UNIT` is let through
however many accounts carry it.

A deployment whose placeholder is spelled otherwise has to say so, or its
second holder of that value is refused, and every existing holder at its next
update of the attribute. The audit cannot warn: uniqueness spans the whole
directory, and it only checks what each entry says on its own.

Find the shared values before switching:

```bash
ldapsearch -LLL -b "ou=users,<base>" "(employeeNumber=*)" employeeNumber \
  | awk '/^employeeNumber:/ {print $2}' | sort | uniq -cd
```

Then name yours in a copy of the schema, as
`static/schemas/example/users.json` does:

```json
"unique": { "sentinel": "YOUR-PLACEHOLDER" }
```

### Calendar resource ids, and the branch they are looked for in

**Who is affected:** deployments loading `core/twake/calendar` (the plugin
`calendarResources` was renamed to).

Three things changed in how an LDAP entry is matched to a Calendar resource.
A resource whose DN is `cn=…` or `uid=…` directly under the configured base,
with no escape in its value, keeps the identifier it had and needs nothing.

**`--calendar-resource-base` must be a full DN.** The branch was tested by
asking whether the DN _contained_ the configured value as text, so a partial
value like `ou=resources` matched — and matched a sibling branch such as
`ou=resourcesArchive` with it. It is compared by DN components now, which
also fixes the other direction: a DN written with spaces after its commas was
not recognised as a resource at all. Give the option the whole DN; the plugin
warns at startup when the value is not one under `--ldap-base`.

**The identifier is read from the entry's own RDN.** It used to come from an
unanchored search for `cn=` or `uid=` anywhere in the DN, so an entry whose
own RDN was neither borrowed the one of an ancestor; failing that, creation
fell back to a slug of the entry's name, under which modification and
deletion then found nothing. An RDN value carrying an escape — `cn=Salle\, 2`
— was cut at the escape.

So an entry of either of those shapes is now created, patched and deleted in
Calendar under a different identifier than before. **The resource Calendar
already holds under the old one is not migrated**: rename it there, or delete
it and let the next write recreate it. List what is affected before
upgrading — every resource whose RDN attribute is neither `cn` nor `uid`, and
every one whose RDN value contains a `\`.

**A modification or a deletion outside the base no longer reaches Calendar.**
Only creation checked the branch; the other two acted on any entry of the
entity whose DN yielded an identifier.

### Renaming an entry, and what the cascade reaches

**Who is affected:** anyone calling the new
`POST /v1/ldap/{resource}/{id}/rename`. Nothing changes for a deployment
that does not.

The identifier of a flat entry can be changed. The entry's DN changes with
it, so everything naming that DN has to be rewritten, and the endpoint waits
for that before it answers.

What it rewrites is read from the schemas, never from a list of attribute
names: every `pointer` — single or in an array — whose `branch` admits the
renamed entry, and every attribute carrying the `members` or `owners` role.
**Load `core/ldap/enterpriseRules`**: without it the entry is renamed and
nothing else is touched.

What it cannot reach is a DN held in a plain `string` attribute that carries
no role. Declare it a `pointer`, or give it its role, and it is covered.

A directory running OpenLDAP's `refint` overlay already fixes the attributes
it is configured for — usually `member`, `owner`, `uniqueMember` and
`memberOf` — in a task of its own, after the rename has answered. The server
converges with it rather than fighting it: what the overlay has already
fixed counts as done. `refint` is not a substitute, though. It never sees a
deployment's own pointers, `twakeManagerLink` and `twakeLocalAdminLink`
among them — and losing the second one silently costs an administrator every
branch they administer.

### A rename answers `207` when it could not finish

The rename of the entry and the rewrite of what points at it are separate
writes, and a directory has no transaction to hold them together.

If the rename itself fails, nothing else has happened and the directory's own
refusal is what you get. Once it succeeds the rename is a fact, and an error
would tell you the opposite — so a rewrite that fails answers `207` with the
attributes and the counts that could not be written. The referring DNs are
not in the body, where the caller has no business reading them; they are in
the log, at `error`, with the attribute and both DNs.

**Re-issue the identical request to finish it.** A rename whose source is
already gone and whose target is already there runs the rewrite alone. That
is also what to do if the server dies between the two writes.

### `unique` is not widened on a rename

A schema marking its identifier `unique: { "branches": [...] }` gets the
RDN's own branch checked on a rename, and nothing more: the wider check runs
from the add and modify hooks, which a rename does not go through. The
endpoint's own description says so too.

### Creating an entry that already exists answers `409`

**Who is affected:** any client that reads a failed creation by its status
code or by the text of its message — a bulk import recording per-line errors
most of all.

Two creations of the same entry racing past the existence checks answered
`500`, the add path having wrapped every LDAP error in a plain `Error`. The
directory's own `entryAlreadyExists` is now recognised once, in
`lib/ldapActions`, so every creation route answers `409` alike: the flat
routes, `POST /ldap/groups`, the organization routes, and the external
members `core/ldap/externalUsersInGroups` inserts.

The message is `Entry <dn> already exists`. The flat routes used to say
`<entity> <dn> already exists`, and `core/ldap/bulkImport` used to record
`LDAP add error: …` in its per-line `errors[]`; both read the same now.
SCIM still answers `uniqueness`, the numeric code being carried on the
error it is given.

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

### The search cache works now, and is off by default

**Who is affected:** deployments that set `--ldap-cache-ttl` (or
`DM_LDAP_CACHE_TTL`) explicitly. Everyone else keeps exactly the behaviour
they had.

The base-scope search cache stored nothing since it was written: the branch
that would have kept a result could not be reached, so every read went to the
directory whatever the option said. It caches now — which means a deployment
that had set the option gets a working cache for the first time, where it used
to get none.

What a write through this service drops is what it changed, its subtree
included, whatever case the DN is written in. What this service cannot know
about, it cannot drop: another replica of it, an LSC synchronisation, a
hand-run `ldapmodify`. A cached read stays as it was until its TTL runs out.

So `--ldap-cache-ttl` now defaults to `0`, which means no caching at all. Set
it only where this service is the sole writer of the entries it reads, and
keep the value under the staleness you are willing to serve.

### `calendarResources` is renamed `calendar`

**Who is affected:** deployments loading `core/twake/calendarResources`, and
plugins importing `ldap-rest/plugin-twake-calendarresources` or looking the
plugin up by name.

Besides calendar resources, the plugin propagates user email and name changes
to the Twake Calendar registered users; the old name hid that. Nothing breaks
yet: `core/twake/calendarResources` still loads the same plugin, registered
under its old name, and logs a deprecation warning. It will be removed in a
future major release, so switch now by **replacing** the old name with the new
one:

```bash
# before
DM_PLUGINS="…,core/twake/calendarResources"
# after
DM_PLUGINS="…,core/twake/calendar"
```

Do not list both: they register under different names, so the loader does not
see a duplicate and runs two instances — every resource change and every user
email or name change is then sent to Calendar twice.

Plugin code should import `ldap-rest/plugin-twake-calendar` and look the
plugin up as `calendar`. Configuration flags (`--calendar-*`) are unchanged.

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
