# Changelog

## Unreleased

### Breaking Changes

- A server started without `--ldap-base` (or `DM_LDAP_BASE`) now refuses to
  start. It used to guess the base from `--ldap-dn`, taking the second RDN of
  the bind DN — `dc=example` for `cn=admin,dc=example,dc=com`, which is not an
  entry, so every subtree search answered `NoSuchObject`. A guessed base that
  happened to exist was worse: the searches returned nothing without an error
  ([notes](docs/usage/upgrading.md#ldap-base-is-now-required))

- `onLdapChange` gives the full values on each side of a change, not the
  values the request named —
  [notes](docs/usage/upgrading.md#onldapchange-gives-full-values)

### Security

- `core/auth/authzLinid1`: an identity holding `*` resolved to the first user
  the pattern matched, and was judged with that user's permissions

- `core/twake/appAccountsConsistency`: deleting a user whose mail holds `*`
  deleted every applicative account the pattern matched

### Features

- `core/twake/cozyProvision`, `core/twake/clouderyProvision`: an empty
  `--cozy-user-deleted-routing-key` stops them publishing the deletion event,
  for a deployment where another plugin publishes it. The instance is still
  deleted

- `core/ldap/onChange` publishes `onLdapEntryChange(dn, before, after)`: the
  entry before and after each add, modify, rename and delete
  ([#206](https://github.com/linagora/ldap-rest/issues/206))

- The `ldap*done` hooks and `onLdapEntryChange` receive who made the write
  and through which door: `actor`, `requestId`, `source` (`rest` or `scim`)
  ([#207](https://github.com/linagora/ldap-rest/issues/207))

- A plugin declares the operational attributes it follows, such as
  `pwdAccountLockedTime`, in `followedOperationalAttributes`, and
  `onLdapEntryChange` gives them on both sides
  ([#208](https://github.com/linagora/ldap-rest/issues/208))

### Bug Fixes

- `core/auth/authzPerBranch`: the `groups` rules of
  `--authz-per-branch-config` granted nothing — a caller's groups were
  looked up with a substring match on an attribute holding DNs, which has no
  substring form, so no group was ever found and the rules were inert
  ([#212](https://github.com/linagora/ldap-rest/issues/212),
  [notes](docs/usage/upgrading.md#group-rules-now-apply)). Group DNs in the
  configuration are now compared as DNs (case and spaces ignored); a uid
  naming several entries gets no group rule rather than the first entry's;
  the group cache is emptied by a write made through ldap-rest that can
  change a membership, and a failed lookup is no longer cached

- `core/auth/authzLinid1`: a uid naming several entries resolved to
  whichever one the server listed first, and a failed lookup read as "no such
  user" — which `--authz-unresolved-user allow` lets through unchecked, and
  which was cached. An ambiguous uid is now refused (403) whatever the
  policy, a failed lookup fails the request without being cached, and the
  lookup searches the configured base (`--ldap-base`) instead of the empty
  one it used to pass, which made every search fail

- Values written into a search filter unescaped: a DN holding `(` or `)`
  failed the search, and one holding `*` matched nothing, a DN attribute
  having no substring match
  - `core/ldap/groups`: a deleted entry stayed in its groups
  - `core/ldap/organizations`: an organization looked empty, and was deleted
    with entries still linked to it
  - `core/ldap/departmentSync`: a renamed organization left the links to it
    behind
  - `core/auth/authzLinid1`: an administrator got no permission from the
    organizations naming them

- `core/ldap/groups`: an entry left its groups as soon as its delete was
  asked for, so a delete that an authorization plugin refused, that failed,
  or that another plugin kept (`core/ldap/trash`) still cost the entry its
  memberships. It leaves them once the delete has landed: the cleanup runs
  just after `delete()` answers, and a cleanup that fails is logged. A group
  losing its last member keeps the `--group-dummy-user` placeholder instead
  of the deleted DN

- `core/ldap/onChange`: a write that leaves every value as it was fires no
  hook, a rename fires them, and a modify of an entry that has children is no
  longer missed. `onLdapDisplayNameChange` builds both names from the whole
  entry, and fires only when the name changed

- `core/ldap/groups`, `core/ldap/organizations` and
  `core/twake/appAccountsApi`: the writes they make now carry the
  who/which-door context the release announces, which they dropped

- `lib/ldapActions.move`, the path `core/ldap/trash` takes: a moved entry now
  tells the plugins it moved, as a rename does. The group cache and the
  resolution cache kept their answer, so a caller kept its grants until the
  TTL ran out

- `lib/authz/base`: a delete now drops what was resolved, which the base's
  own comment already described. An administrator deleted through the API
  kept their session's rights until the TTL ran out — the identity still
  resolved to the former DN, where the organization still named them

## v0.9.0 (2026-09-24)

Authorization that says what it judges: rules keyed on a login rather than on
whatever an authenticator publishes, plugins scoped to the authenticators
whose requests they judge, and a server that refuses to start on a
combination nobody decided. Several paths where a request went unchecked are
closed, and closing them changes what some deployments answer.

**Read [Upgrading](docs/usage/upgrading.md) before deploying this one.** Every
change below that needs a decision links to its notes there.

### Breaking Changes

- Two authorization plugins judging the same requests stop the server, unless
  `authz_for` separates them or `--authz-combine` keeps the AND they composed
  as. `GET /v1/authz/scope` answers `described: false` where nothing can
  describe the caller's scope, rather than `unrestricted: true`
  ([#189](https://github.com/linagora/ldap-rest/issues/189),
  [notes](docs/usage/upgrading.md#two-authorization-plugins-judging-the-same-requests-no-longer-start))

- A second word after an option taking a list — `--authz-for oidc authToken`
  — is refused rather than dropped in silence —
  [notes](docs/usage/upgrading.md#a-second-word-after-an-option-taking-a-list-is-refused)

- `getLogger()` is typed `winston.Logger | undefined`: a plugin reading it
  without a guard stops compiling
  ([#199](https://github.com/linagora/ldap-rest/issues/199),
  [notes](docs/usage/upgrading.md#getlogger-may-return-undefined-and-its-type-says-so))

- `/subnodes/search` caps its matches at `--ldap-organization-max-subnodes`
  and ends the list with the `moreIndicator` row `/subnodes` already used —
  [notes](docs/usage/upgrading.md#subnodessearch-caps-what-it-returns)

- `DM.claimedAuthPrefixes` and `claimedPrefixes` are gone: nothing called
  them, and they described a mechanism the dispatcher does not implement

### Security

- `lib/authz/base`: an authenticated identity that did not resolve skipped
  every check, so `authzLinid1` behind OpenID Connect or LLNG checked nothing
  across the whole tree. It is refused now, and `--authz-unresolved-user
allow` restores the old behaviour —
  [notes](docs/usage/upgrading.md#an-identity-that-does-not-resolve-is-refused)

- `core/auth/authzDynamic`: the token ACLs stepped aside for any request
  another authenticator had identified, so a `core/auth/token` static token
  reached the whole directory unscoped. They apply to every token now, and
  `--authz-dynamic-bypass` names what may pass without one —
  [notes](docs/usage/upgrading.md#authzdynamic-no-longer-steps-aside-for-another-authenticator)

- `core/auth/openidconnect`: `auth_path_prefix` was ignored, a named instance
  could mount after `authzPerRoute` and leave its rules inert, and a second
  authentication composed as an AND. It registers with the authentication
  dispatcher now —
  [notes](docs/usage/upgrading.md#openid-connect-honours-auth_path_prefix)

- `core/auth/llng`: a request a `skip` rule let through was published as
  authenticated by nobody, which every authorization plugin skips. It answers
  401 now, and an identity header sent by the client is dropped
  ([#190](https://github.com/linagora/ldap-rest/issues/190),
  [notes](docs/usage/upgrading.md#coreauthllng-refuses-a-request-the-handler-named-nobody-for))

- `core/ldap/organizations`: `/subnodes/search` searched without the request,
  so no authorization plugin checked it — the gap `abstract/ldapFlat` closed
  in 0.8.2 —
  [notes](docs/usage/upgrading.md#subnodessearch-is-authorized-and-lists-the-children-by-page)

- `lib/authz/base`: moving an entry out of an organization the caller could
  not read went through, the refusal being swallowed by its own `catch`

- `bin`: a named instance of a priority plugin —
  `core/auth/trustedProxy:tp2:{…}` — lost its rank and could register after
  the routes it guards, letting a forged `X-Forwarded-For` reach what
  `rateLimit` and `crowdsec` key on

### Features

- `--authz-identity`: authorization rules can be keyed on a login. Every
  authenticator publishes `req.userName` beside `req.user` —
  `--oidc-username-claim`, `--llng-username-header` — and says at startup
  what it publishes
  ([#187](https://github.com/linagora/ldap-rest/issues/187),
  [notes](docs/usage/plugins/auth/README.md#what-a-rule-is-keyed-on))

- `authz_for` scopes an authorization plugin to the authenticators whose
  requests it judges, recorded in `req.authenticators`;
  `--authz-scope-source` chooses which one `authzScope` answers with
  ([#189](https://github.com/linagora/ldap-rest/issues/189),
  [notes](docs/usage/plugins/auth/README.md#several-authorization-plugins))

- `core/storage`: keyed storage with a deadline, in an LDAP branch or in a
  directory of files — [notes](docs/usage/plugins/utilities/storage.md)

- Back-Channel Logout: `core/bcl` ends the session here when the provider
  ends it — [notes](docs/usage/plugins/auth/back-channel-logout.md)

- `--authz-filter-attached-entries`: an account is judged by the
  organization it is attached to rather than by the `ou=users` every account
  shares. Off by default —
  [notes](docs/usage/upgrading.md#judging-an-account-by-what-it-is-attached-to)

- `lib/ldapActions`: `ldap.system` for the reads that are nobody's request —
  a uniqueness or referential-integrity check
  ([#190](https://github.com/linagora/ldap-rest/issues/190))

### Bug Fixes

- A refused LDAP operation names the authorization plugin that refused it in
  the log, and each plugin says at startup what it judges
  ([#189](https://github.com/linagora/ldap-rest/issues/189))

- `lib/auth/base`: the `afterAuth` hooks never ran. They run on every
  authenticated request now

- `core/ldap/organizations`: a node with more children than the directory
  lists in one answer returned `200 []` from `/subnodes`. It returns what the
  directory gives and a row saying there is more, and its children are
  searched by page
  ([#179](https://github.com/linagora/ldap-rest/issues/179),
  [notes](docs/usage/plugins/ldap/organizations.md#get-organization-subnodes))

- `lib/utils`: a hook failing under `launchHooks` threw from its own error
  report, the logger having been captured before `setLogger` — an unhandled
  rejection, or a refused OpenID Connect login. It is reported now, with the
  plugin and hook it belongs to
  ([#182](https://github.com/linagora/ldap-rest/issues/182))

- `lib/expressFormatedResponses`: `serverError` reached before `setLogger`
  threw instead of sending its response
  ([#199](https://github.com/linagora/ldap-rest/issues/199))

## v0.8.2 (2026-09-23)

### Security

- `abstract/ldapFlat`: reading, listing, modifying and deleting a flat entity
  ran with no authorization check. The request never reached the directory
  call, and every plugin skips its check without one, so any authenticated
  caller reached every account whatever branch they were granted.
  `renameEntry` was fixed for this in 0.8.0, the four others were left

## v0.8.1 (2026-09-22)

### Bug Fixes

- `plugins/ldap/groups`: a branch under the group base — an `ou=` holding some
  of the lists — was answered as a group of its own. The listing searches the
  whole subtree and asks for the main attribute; an entry without one is
  answered with an empty array, which the guard meant to skip a nameless entry
  read as a name, so the branch reached the client keyed on `""`. A console
  listing groups showed a row with no name, and an empty option wherever it
  let one be picked

## v0.8.0 (2026-09-22)

An enterprise directory manager: the rules a real deployment needs, the
endpoints an administration console reads, and a script that says what a
migration will refuse before it does. The console itself is
[Twake Directory Manager](https://github.com/linagora/twake-directory-manager).

**Read [Upgrading](docs/usage/upgrading.md) before deploying this one.** Every breaking change
below is explained there, with what to do about it.

### Breaking Changes

- Node 20 is the floor, the version Debian 13 ships —
  [notes](docs/usage/upgrading.md#node-20-is-the-floor)

- `static/schemas/twake` describe an enterprise directory rather than a bare
  CRUD surface: `uid`, `twakeDepartmentPath`, `twakeAccountStatus` and
  `twakeDeliveryMode` are computed and refused in a request body, and the
  schemas need `core/ldap/enterpriseRules` loaded —
  [notes](docs/usage/upgrading.md#the-twake-schemas-now-need-coreldapenterpriserules),
  [notes](docs/usage/upgrading.md#clients-must-stop-sending-the-computed-attributes)

- `static/schemas/twake/users.json` requires `employeeNumber`, `displayName`
  and `givenName`, `cn` stops being required, and `employeeNumber` is unique
  apart from the `UNIT` placeholder —
  [notes](docs/usage/upgrading.md#employeenumber-is-unique-apart-from-the-unit-placeholder)

- An array's `items.test` and `items.branch` are enforced on the flat,
  organization and group routes, where they never were. Stored values are
  untouched — [notes](docs/usage/upgrading.md#run-the-audit-before-switching)

- `twakeDepartmentPath` reads from the root down; what a directory of the old
  convention holds is still accepted —
  [notes](docs/usage/upgrading.md#organization-paths-nothing-to-convert)

- A flat schema claiming a name another schema or an LDAP plugin already
  serves is refused instead of loading unreachable —
  [notes](docs/usage/upgrading.md#a-flat-schema-may-not-claim-a-url-an-ldap-plugin-serves)

- `--ldap-cache-ttl` defaults to `0`: the search cache is off until asked for
  — [notes](docs/usage/upgrading.md#the-search-cache-works-now-and-is-off-by-default)

- `core/auth/llng` needs a configuration it can use at startup, and stops the
  server without one —
  [notes](docs/usage/upgrading.md#the-llng-handler-now-needs-a-working-configuration-at-startup)

### Security

- Bump `csv-parse` to 7.0.2 (GHSA-8cw4-87c7-c6xx): a `__proto__` header would
  have been copied onto the entry `plugins/ldap/bulkImport` was building, and
  replaced its prototype wherever that cell held several values — assigning a
  string to `__proto__` is a silent no-op, assigning the array a cell holding
  a `;` becomes is not

### Features

- `plugins/ldap/enterpriseRules`, `plugins/ldap/accountLifecycle` and
  `plugins/auth/authzScope`: the rules a directory needs, the status and
  password endpoints, and the answer to which branches a caller administers.
  None holds an attribute name, a domain or a nomenclature value — every rule
  is a schema marker on `abstract/ldapFlat` (`role`, `hint`, `generated`,
  `readOnly`, `neverReturn`, `generatedFrom`, `searchable`), see
  [flat-generic](docs/usage/plugins/ldap/flat-generic.md)

- `POST /v1/ldap/{resource}/{id}/rename` changes an identifier and rewrites
  what named its DN before it answers, `207` when a rewrite did not land —
  [notes](docs/usage/upgrading.md#renaming-an-entry-and-what-the-cascade-reaches)

- `GET /ldap/{entity}?match=…&attribute=a,b,c` answers on any of several
  attributes, `searchable` saying which are worth scanning

- `npm run audit:directory` reports what a schema would refuse of what is
  already stored, quoting each rule's own `hint`, see
  [directory-audit](docs/usage/directory-audit.md)

- `static/schemas`: the missing `domains` nomenclature, English and French
  labels on every Twake nomenclature and on its values
  (`entity.valueLabels`), and `static/schemas/example`, a worked configuration
  keeping national formats, mail domains and quota defaults out of the code

### Bug Fixes

- `plugins/twake/calendar`: only the creation hook checked that an entry was
  in the resource branch — a modification or a deletion reached Calendar for
  any entry of the entity — and the branch was matched as text, so a partial
  `--calendar-resource-base` took a sibling branch with it and a DN written
  with spaces was not recognised at all. The resource identifier came from an
  unanchored search for `cn=`/`uid=`, so an entry whose own RDN was neither
  borrowed an ancestor's; it is read from the entry's own RDN now, unescaped,
  and the three hooks share it. It is percent-encoded in the WebAdmin path,
  see
  [Upgrading](docs/usage/upgrading.md#calendar-resource-ids-and-the-branch-they-are-looked-for-in)

- `lib/ldapActions`: a cached entry was handed out with its value arrays
  shared, so a caller sorting one or appending to it wrote into the cache and
  every later reader saw it until the TTL ran out. They are copied

- `abstract/ldapFlat`: `renameEntry` never handed the request on, so a rename
  through it ran with no authorization check at all, and accepted identifiers
  the schema refuses on creation. The route is new in this release, so no
  deployment was exposed

- Creating an entry that already exists answered `500` on some routes and
  `409` on others; it is recognised once, in `lib/ldapActions`, and answers
  `409` everywhere —
  [notes](docs/usage/upgrading.md#creating-an-entry-that-already-exists-answers-409)

- `lib/ldapActions`: the base-scope search cache never stored a result, and
  `rename` and `move` dropped nothing when they changed one —
  [notes](docs/usage/upgrading.md#the-search-cache-works-now-and-is-off-by-default)

- `plugins/auth/llng` never initialized the LemonLDAP::NG handler, so every
  request answered `500`, and two instances given different `--llng-ini`
  silently shared one configuration

- `plugins/ldap/groups`: the placeholder member is hidden when a group is read
  as well as listed, and recognised by its DN wherever it is read — the delete
  guard, SCIM and `plugins/twake/james` all compared text. Refusing to remove
  it answers `400`, and a listing that did not ask for `member` no longer
  answers `"member": [null]`

- `abstract/ldapFlat`: a pointer's `branch` was matched as a text suffix;
  `searchEntriesByName` interpolated its value into an LDAP filter raw; and a
  business rule that refused a creation answered `500`

- `plugins/ldap/organizations`: `ou` rejected every name carrying a space, an
  apostrophe or an `&` — which is most of a real directory

- `plugins/ldap/departmentSync`: moving or renaming an organization left its
  subtree, and the users and groups linked to it, on the former parent's path

### Improvements

- `plugins/twake/calendar` looks a registered user up by email instead of
  downloading every one. Releases before 1.0.0.1 ignore the parameter and keep
  working

- `plugins/ldap/flatGeneric`: `entity.valueLabels` reaches a client at the top
  level of its `flatResources` entry, beside `label` and `singularLabel`

- `generatedFrom.regenerateOnChange` is gone — declared, documented, and read
  nowhere. The rename endpoint is what changes an identifier

### Dependencies

- `csv-parse` 7 trims ECMAScript whitespace: cells padded with a non-breaking
  space are now trimmed, and a BOM before the first header no longer ends up
  in the column name

### Deprecations

- `plugins/twake/calendarResources` is renamed `plugins/twake/calendar`, see
  [Upgrading](docs/usage/upgrading.md#calendarresources-is-renamed-calendar)

## v0.7.0 (2026-09-02)

See [Upgrading](docs/usage/upgrading.md) before deploying this one.

### Breaking Changes

- `plugins/scim`: a Group's `externalId` no longer answers its `entryUUID`.
  RFC 7643 section 3.1 makes it the _provisioning client's_ identifier, so
  serving a server-assigned value discarded the id Okta or Entra ID sent, and
  `filter=externalId eq "<their id>"` searched `entryUUID` and matched
  nothing. Name an attribute with `--scim-group-external-id-attribute` to
  store it; left unset, `externalId` is not supported on Groups. Users are
  unaffected — theirs was already in `employeeNumber`

### Features

- `plugins/scim`: SCIM `active` is writable — how Okta and Entra ID disable a
  user. It was read-only, so a deactivation was silently dropped on create and
  answered `400 invalidPath` on PATCH. It is modelled on the presence of one
  LDAP attribute, `--scim-user-lock-attribute` (default `pwdAccountLockedTime`,
  which needs the ppolicy overlay) written with `--scim-user-lock-value`

- `plugins/scim`: `attributes` and `excludedAttributes` (RFC 7644 section 3.9)
  are honoured instead of parsed and dropped — on the lists, the
  single-resource GETs and the answers of POST, PUT and PATCH

- `lib/ldapActions`: `forRequest(req)` binds every directory operation to one
  request, so the authorization hooks always see it. The unbound methods take
  the request as a trailing optional argument and omitting it skips every
  check silently — four such bugs shipped. Request handlers should bind once;
  an eslint rule enforces it across the SCIM plugin

### Bug Fixes

- `plugins/scim`: four ways a deactivation could answer `200` and leave the
  account binding — the string `"false"` unread by POST and PUT, a `PUT`
  omitting `active` releasing the lock anyway (so a routine profile sync
  defeated a ppolicy auto-lockout), a `PUT` swallowing the directory's
  refusal, and lock configurations that could never lock, now refused at
  startup

- `plugins/scim`: PATCH operations play in the order RFC 7644 section 3.5.2
  gives them, against the entry as it stands, and only the difference is sent.
  Two operations on one attribute no longer collapse into whichever the
  emitter kept, and an add stays an incremental LDAP `add` rather than a
  computed `replace` that would drop a concurrent one

- `plugins/scim`: `remove` on a Group's `members` naming members that all fail
  to resolve — an identity provider withdrawing someone the directory no
  longer holds — was read as the bare `remove members` and emptied the group,
  answering `200`. Only the bare form means all

- `plugins/scim`: removing an attribute the entry does not hold no longer
  fails the whole atomic modify, taking the operations sent alongside it down
  with it

- `plugins/scim`: `/Bulk` answered `500` quoting the raw error, including the
  `[authz-forbidden]` marker and the branch DN behind it. It applies the same
  translation as every other route now

- `plugins/scim`: a directory whose schema does not define the lock attribute
  answered a bare `500` to any deactivation; it is `400 invalidValue` naming
  the flags to change

- `lib/ldapActions`: the wrappers around `add`, `modify`, `rename`, `move` and
  `delete` dropped the driver's numeric result code, leaving callers to tell
  noSuchObject from a schema refusal by matching its wording

- `lib/ldapActions`: a `modify` that emitted none of the changes it was given
  is a `warn` naming the DN, no longer a `debug` line shared with the routine
  empty case

## v0.6.2 (2026-09-02)

### Security

- `plugins/ldap/onChange`, `plugins/ldap/organizations`: both rebuilt the hook
  tuple without the request. `launchHooksChained` feeds each hook's return
  value to the next, so an authorization plugin registered after either of
  them saw no request — and `shouldSkipAuthorization()` returns true the
  moment it is missing. Every `modify`, and every `rename` for the second
  plugin, went through unchecked, whatever `core/auth/authzPerBranch` or
  `core/auth/authzLinid1` said. `core/auth/authzDynamic` was not affected: it
  reads its token from an `AsyncLocalStorage` rather than from the request.

  Neither plugin sits in `priority.json`, and the remaining plugins load
  concurrently, so which side of the line a deployment fell on was decided by
  a load race and could differ from one restart to the next. Present since at
  least v0.4.7.

  Note for upgrades: writes that this bypass was letting through are refused
  now. An identity whose grants were never quite right may start seeing `403`
  where it saw `200` — that is the fix, not a regression, but check your
  `authzPerBranch` or `authzLinid1` grants before rolling this out widely

### Bug Fixes

- `plugins/scim`: `active` was answered as `true` for every user, locked ones
  included. It is read from the presence of `pwdAccountLockedTime`, which is
  operational and no search named it, so a disabled account was reported to
  the provisioning system as enabled

- `plugins/scim`: a `PATCH` whose operations all translated to no LDAP change
  answered `200` without reaching `ldapActions`, where write permission is
  checked, so an identity with read and no write was told its write had
  succeeded. Nothing was written either way — the answer was the problem, and
  a provisioning system records it as applied

- `plugins/scim`: a filter on `active pr` emitted `(active=*)`. `active` is
  not an LDAP attribute, so the directory refused the search with `attribute
type undefined`

- `plugins/ldap/onChange`: the entry snapshot taken before each modify was
  only ever cleared when the operation was unknown, so the map grew by one
  entry per modify for the lifetime of the process

## v0.6.1 (2026-09-02)

### Breaking Changes

- `plugins/scim`: reads are now authorized — a breaking change shipped in a
  patch release because it closes a read-authorization bypass. Every
  `ldapActions.search()` the plugin issued omitted the request, so
  `ldapsearchrequest` — the hook the authorization plugins use — skipped its
  check, and any authenticated identity could read any branch the plugin was
  pointed at whatever `core/auth/authzPerBranch` or `core/auth/authzLinid1`
  said. `core/auth/authzDynamic` was not affected: it reads its token from
  an `AsyncLocalStorage` rather than from the request. `GET /Users`,
  `GET /Users/{id}` and their Group counterparts now answer `403` where read
  is denied.

  The bypass is not new — it predates 0.6.0 — but the pagination fix in this
  same release removes what used to limit it. A list previously refused with
  `tooMany` past `--scim-max-results`, so an unauthorized read of a subtree
  larger than 200 entries returned nothing; it now pages through the whole
  subtree. Fixing the two together is the point.

  Note for upgrades: an identity that writes needs `read` on the same branch.
  A SCIM write answers with the resource it just changed, so it reads the
  entry back, and a grant of `write` without `read` no longer serves a write

### Security

- `plugins/scim`: `PATCH /scim/v2/Users/{id}` called `ldapActions.modify()`
  without the request, so every authorization plugin skipped its check — a
  token denied write on a branch could still modify a user there through
  PATCH. POST, PUT and DELETE, and the Groups PATCH, were unaffected
- dependencies update

### Bug Fixes

- `plugins/scim`: `meta.created` and `meta.lastModified` carried the
  directory's GeneralizedTime (`20250101120000Z`) straight through. RFC 7643
  section 2.3.5 wants an `xsd:dateTime`, so a strict client rejected every
  resource. They are now converted (`2025-01-01T12:00:00Z`)

- `plugins/scim`: a create answered 201 without the `Location` response header
  RFC 7644 section 3.1 requires — only `meta.location` inside the body. It is
  now sent on POST, and on the PUT and PATCH answers as well

- `plugins/scim`: a PATCH `remove` operation without a `path` was applied to
  every key of its `value` instead of being refused. RFC 7644 section 3.5.2.2
  requires `400` with `scimType: noTarget`, since a pathless remove names no
  target

- `plugins/scim`: a list could not be served at all beyond
  `--scim-max-results`. `GET /Users` and `GET /Groups` fetched their whole
  result set and answered `400 tooMany` as soon as it passed that figure — so
  a directory of more than 200 entries was unlistable, filter or no filter,
  and no `startIndex` reached past that window. RFC 7644 section 3.4.2.4 asks
  for a page. The window is now cut server-side while walking a paged search:
  `startIndex` reaches any offset, `totalResults` is the real size of the
  result set, and only the requested page is held in memory

  Two notes on configuration. `--scim-max-results` keeps its name but now
  means the maximum page size — the cap on `count`, which is what
  `ServiceProviderConfig.filter.maxResults` advertises. And the new
  `--scim-max-scanned` (10000) bounds how far a list walks to count its
  result set, past which `tooMany` is answered as RFC 7644 section 3.12
  provides for

## v0.6.0 (2026-08-01)

### Breaking Changes

- `plugins/twake/appAccounts*`: applicative entries are built from an allowlist
  (`--applicative-account-attribute`) instead of the whole user entry minus
  `--ldap-operational-attribute`. An attribute not named there is no longer
  copied into the applicative branch — name it to keep it (#103)

- `plugins/twake/appAccountsConsistency`: a mail change now deletes the app
  accounts instead of recreating them without their password. They could not
  authenticate, yet were still listed and still counted against
  `--max-app-accounts` (#103)

### Security

- `lib/utils`: a DN read from a JSON body was parsed by looping on its
  `.length`, so `{"length": 1e100}` hung the worker (CWE-834). `parseDn()` and
  `unescapeDnValue()` now answer 400 on a non-string

- `plugins/ldap/groups`: `member`, `targetOrgDn` and `newCn` were forwarded
  without a type check, unlike the equivalent organization and flat-branch
  endpoints; a non-string now gets a 400

- `lsc-plugin`: jackson-databind 2.17.2 → 2.22.1, clearing five advisories
  (CVE-2026-54512, CVE-2026-54513, CVE-2026-54514, CVE-2026-54515,
  CVE-2026-59888)

## v0.5.0 (2026-08-01)

### Features

- `plugins/ldap/raw` + `browser/ldap-browser`: read-only low-level browsing of
  the directory — root DSE, parsed schema (RFC 4512, `SUP` chains resolved),
  any entry by DN with its operational attributes, the children of a node, and
  arbitrary searches. Access is bounded by `--ldap-raw-base`, narrowed by the
  authorization plugins, and credential attributes (`userPassword` and its
  Samba, Kerberos and AD counterparts) are stripped unless
  `--ldap-raw-show-secrets` says otherwise. The browser library ships a tree, a
  schema-annotated attribute table and a filter search, demo page at
  `/static/examples/web/ldap-browser.html`

- `lib/auth`: `--auth-path-prefix` scopes an authentication plugin to path
  prefixes, so one server can serve populations that authenticate differently —
  `/api/m` behind a token, `/api/admin` behind OIDC. A credential is only valid
  on the branch it was scoped to, and a plugin left unscoped guards everything
  no other plugin claims. Authentication is dispatched from a single layer the
  server mounts, so declaration order no longer decides what is protected and
  the most specific claim wins. A route outside every prefix with no unscoped
  plugin is served without authentication: those routes are named in a warning
  at startup. Plugins extending `AuthBase` no longer mount a middleware of
  their own: `api()` registers them with the dispatcher, so a third-party
  plugin that called `super.api(app)` keeps working, but one that relied on
  where its layer sat in the stack no longer can

### Bug fixes

- `bin`: a plugin loaded with overrides (`module:name:{json}`) received a
  server view built by spreading, so it carried the data but none of the
  methods and any `this.server.something()` threw

- `bin`: the error middleware was never replaced, only stacked — the lookup
  used Express 4's `app._router`, which Express 5 renamed

- `bin`: a plugin registered under a name already taken was dropped at `info`
  level, so its routes answered 404 with nothing in the log to explain it; now
  a warning naming the plugin and how to load one twice

- `plugins/auth/rateLimit`: warn when `core/auth/trustedProxy` is absent. The
  limiter keys on `X-Forwarded-For`, which is forgeable without it, and the
  brute-force protection is then decorative

- `plugins/twake/appAccountsApi`: never report a password operation that did
  not happen. `POST` used to return `200` with a password that authenticated
  nowhere when the principal update failed, and `DELETE` removed an app account
  while leaving its credential valid. Both now return `500`; `DELETE` keeps the
  account so the call stays replayable, and a password already absent counts as
  revoked (#105)

### Internal

- Tooling and tests, no runtime change: coverage is measured and gated in CI
  (`npm run coverage`, `npm run coverage:check` — 86.6% of statements on server
  code), the fourteen ESLint errors are cleared and CI now runs lint and format
  checks, and tests wait on the condition they expect instead of a fixed delay

## v0.4.7 (2026-07-26)

### Features

- `plugins/weblogs`: let any plugin enrich the access log line. The entry said
  _that_ a request happened, never _what_ was requested, so on `POST` / `DELETE`
  routes carrying their parameters in the body the URL alone was useless for
  auditing. A handler can now set `req.logDetails = { … }` and those fields are
  merged into the single `notice` entry emitted when the response completes — no
  second log line to correlate by timestamp. Core fields (`method`, `url`,
  `status`, `duration`, `ip`, `user`, `error`) always take precedence, so a
  plugin cannot spoof them (#104)

## v0.4.6 (2026-07-17)

### Features

- docker images amd64 + arm64
- CI: automated release pipeline triggered on `vX.Y.Z` tags. Each tag now
  builds and pushes multi-arch (amd64 + arm64) Docker images to
  `ghcr.io/linagora/ldap-rest` and `docker.io/yadd/ldap-rest`, publishes the
  Helm chart as an OCI artifact to `oci://ghcr.io/linagora/charts/ldap-rest`,
  publishes the npm package (via npm OIDC Trusted Publishing, with a provenance
  attestation), and cuts a matching GitHub Release. Prerelease tags
  (`vX.Y.Z-rc.N`) are published to the npm `next` dist-tag (#101, #102)
- `helm/ldap-rest`: Helm chart for deploying ldap-rest on Kubernetes. Derived
  from the in-house deployment chart (same `env` / `secrets` /
  `externalFileConfig` values interface) with TCP probes, optional ingress and
  service account, and standard Helm labels (#101)

## v0.4.5 (2026-07-16)

### Features

- `bin/sync-james`: reconcile mail aliases in addition to quotas, as a catch-up
  for aliases that were not propagated to James (e.g. when the event-based sync
  failed).

## v0.4.4 (2026-07-10)

### Features

- `plugins/twake/calendarResources`: propagate LDAP user identity changes
  (email, first name, last name) to the Twake Calendar registered users via the
  WebAdmin API. Registered users are keyed by an internal id and
  `GET /registeredUsers` exposes no filter, so the plugin lists the registered
  users, locates the entry by email, then `PATCH /registeredUsers?id={id}` with
  the LDAP values. The sync is driven by the configured mail / first name / last
  name attributes — `--calendar-firstname-attribute` (default `givenName`) and
  `--calendar-lastname-attribute` (default `sn`) (#100)

### Bug Fixes

- `plugins/twake/james`: use the standard Apache James / Twake-Mail WebAdmin
  routes. The forwards and JMAP identities calls targeted routes that do not
  exist and silently returned 404: forwards now use
  `/address/forwards/{mail}/targets/{forward}` (was
  `/domains/{domain}/forwards/…`) and identities `/users/{mail}/identities` (was
  `/jmap/identities/{mail}`). The mailbox rename call also gains the required
  `force` query parameter and is now skipped when the new mail is empty instead
  of renaming the mailbox to a literal `null` address (#99)
- `plugins/scim`: force usernames to lowercase on SCIM user creation (#96)

## v0.4.3 (2026-07-08)

### Bug Fixes

- `plugins/twake/clouderyProvision`: skip instance creation when an instance
  already exists for the computed FQDN. The instance slug is deterministic, so
  when a user is re-imported after their LDAP entry was recreated while the
  Cloudery instance survived, the existing instance is now reused instead of
  letting Cloudery mint a numbered duplicate (`slug2`). The existence lookup
  fails open: if it errors, provisioning falls through to create as before (#94)

### Misc

- Dockerfile: add the missing `DM_CLOUDERY_INVITED_ATTRIBUTE="twakeInvited"`
  environment default, backing the invited-attribute feature introduced in
  v0.4.1

## v0.4.2 (2026-07-06)

### Bug Fixes

- `plugins/twake/clouderyProvision`: force `cn` to the `userName` when
  provisioning B2B users. The core SCIM mapping sets `cn` from
  `name.formatted`, which is not the desired value for B2B provisioning (#93)

### Misc

- `plugins/twake/clouderyProvision`: added detailed provisioning logs

## v0.4.1 (2026-06-30)

### Features

- `plugins/twake/clouderyProvision`: provisioned B2B users are now marked as
  pending invitation. On provisioning, the configurable invited attribute
  (`twakeInvited` by default, set via `cloudery_invited_attribute` /
  `DM_CLOUDERY_INVITED_ATTRIBUTE`) is written as `"TRUE"` on the user entry;
  the registration app clears it to `"FALSE"` once onboarding completes (#90)

## v0.4.0 (2026-06-19)

### Breaking Changes

- `core/twake/appAccountsApi`: the `:user` path param of the app-account
  endpoints is now resolved against the **mail** attribute (globally unique) by
  default, instead of the LDAP `uid`. `uid` is not unique across the directory,
  so the previous lookup could create/list/delete app accounts against the
  wrong same-named user (#88). Callers must now pass the principal email as
  `:user`. Set `app_accounts_user_attribute=uid`
  (`DM_APP_ACCOUNTS_USER_ATTRIBUTE=uid`) to restore the previous `:user = uid`
  contract — only safe where uid is unique directory-wide. Generated
  app-account uids are now prefixed from the (sanitized) resolved `:user`
  value: `<sanitized-mail>_c<digits>` by default, still `<uid>_c<digits>` in
  uid mode
- Authorization denials from `core/auth/authzPerBranch` now return **403** for
  every operation (read, write, move, delete); previously read and move
  denials surfaced as `500`. This aligns it with `core/auth/authzDynamic`

### Bug Fixes

- SCIM writes now honour `core/auth/authzPerBranch` (#80). `core/scim` did not
  propagate the authenticated request down to the LDAP action layer, so the
  `ldap{add,modify,delete}request` authorization hooks ran without `req.user`
  and `shouldSkipAuthorization` allowed the write unconditionally — an identity
  restricted to one branch could create or delete entries in any branch via
  SCIM. The request is now threaded through every SCIM `ldap.add/modify/delete`.
  `ldap.delete` also gained a `req` argument and `AuthzBase` now implements a
  `ldapdeleterequest` hook (it enforced no delete permission before). The
  `authzDynamic` path was unaffected (it reads its token from AsyncLocalStorage)
- `core/twake/appAccountsApi`: escape LDAP filter metacharacters in principal
  and uid lookups, reject ambiguous principal lookups with `409` instead of
  silently using the first match, and guarantee a generated app-account uid is
  unique across the whole applicative branch (prevents cross-user collisions in
  the shared branch)

## v0.3.10 (2026-06-19)

### Bug Fixes

- `core/twake/appAccountsApi`: drop the unused `core/auth/token` dependency
  (#83). It auto-loaded the token-auth plugin and registered its global
  middleware, forcing Bearer auth on the app-accounts endpoints and
  returning `401` under HMAC-only deployments. The plugin never reads
  `req.user` or the token, so the dependency enabled nothing; the endpoints
  now use the deployment's configured authentication like every other API
  plugin
- `core/twake/appAccountsConsistency`: harden the re-entrancy guard so that
  deleting a single app account no longer cascades into deleting the user's
  other app accounts and principal entry (#84). The guard compared the
  configured `applicative_account_base` as a plain string suffix, which
  false-negatived on DN-format differences (case, whitespace around
  separators, escaped commas, multi-valued RDN ordering) returned by the
  server, letting the plugin's own delete event slip through and trigger the
  delete-by-mail cascade. It now relies on new `normalizeDn` / `isDnInBranch`
  helpers in `lib/utils` for a robust RDN-by-RDN comparison (`normalizeDn`
  avoids a ReDoS-prone regex flagged by CodeQL). The previously
  load-time-skipped `appAccounts*` test suites now actually run in CI, plus a
  regression test covering the single-delete case
- `sync-app-accounts`: fix the bulk backfill CLI, which previously could
  not create any principal account and never returned control. A
  base-scoped search on a missing entry raises `noSuchObject` instead of
  returning an empty set, so it is now treated as "absent" and the missing
  principal is created. Attributes that come back as empty arrays (a
  requested-but-absent attribute) are skipped to avoid `add` errors
  (`no values for attribute type`). The script now fails fast with a clear
  message when `applicative_account_base` does not exist, drops a broken
  `unbind()` teardown call, and exits cleanly once finished (pooled LDAP
  connections were keeping the process alive after the summary)

## v0.3.9 (2026-06-18)

### Bug Fixes

- `core/twake/appAccountsConsistency`: ignore mail-change events whose DN
  originates in the applicative branch (`applicative_account_base`). Those
  entries are outputs of the plugin, never source users, so reacting to the
  plugin's own writes caused idempotent `AlreadyExists` churn and, during a
  mail change, a re-entrant deletion cascade that could drop a user's app
  accounts. This makes it safe to nest `applicative_account_base` under
  `ldap_base`

## v0.3.8 (2026-06-18)

### Improvements

- `core/twake/clouderyProvision`: provisioned users now carry their
  organization role and phone numbers. The role is read from a request
  header (`--cloudery-org-role-header`, `DM_CLOUDERY_ORG_ROLE_HEADER`,
  default `x-cloudery-org-role`), falling back to
  `--cloudery-default-org-role` (`DM_CLOUDERY_DEFAULT_ORG_ROLE`, default
  `member`), and is written back to the LDAP entry under
  `--cloudery-org-role-attribute` (`DM_CLOUDERY_ORG_ROLE_ATTRIBUTE`,
  default `twakeOrganizationRole`). Phone numbers are taken from
  `--cloudery-phones-attribute` (`DM_CLOUDERY_PHONES_ATTRIBUTE`, default
  `twakePhones`) and sent during provisioning

## v0.3.7 (2026-06-17)

### New Features

- `core/twake/cozyProvision` and `core/twake/clouderyProvision`: the
  RabbitMQ routing keys for the user-created and user-deleted events are
  now configurable via `--cozy-user-created-routing-key`
  (`DM_COZY_USER_CREATED_ROUTING_KEY`) and
  `--cozy-user-deleted-routing-key` (`DM_COZY_USER_DELETED_ROUTING_KEY`),
  defaulting to `user.created` and `domain.user.deleted`

## v0.3.6 (2026-06-17)

### New Features

- New plugin `core/twake/clouderyProvision`: hooks the SCIM lifecycle to
  provision a Cloudery instance on user create and tear it down on delete.
  It writes the returned workspace FQDN and organization id back onto the
  LDAP entry, and publishes the `user.created` and
  `domain.user.deleted` events. Provisioning is gated on workflow success,
  and the deletion event is only emitted once the instance is actually
  destroyed
- `core/scim/baseResolver`: support resolving the SCIM insertion base from
  a request header, gated to a configured root and never overriding an
  explicit per-user map entry, so one shared auth token can serve every
  organization
- New shared `rabbitmq` plugin, extracted from `cozyProvision`, so any
  plugin can publish lifecycle events on a common connection
- New `lsc-plugin`: an LSC destination plugin (Java) that routes sync
  writes through ldap-rest's HTTP API instead of binding LDAP directly, so
  they benefit from ACL, schema validation, audit, and the downstream
  provisioning hooks. Supports Bearer and HMAC-SHA256 auth and maps the
  CREATE/UPDATE/DELETE/MODRDN operations onto the matching endpoints

### Build

- `rollup`: resolve external builtins and dependency subpaths

### Dependencies

- Update dependencies

## v0.3.5 (2026-05-18)

### Bug Fixes

- `core/twake/appAccountsConsistency`: rename the config key
  `ldap_operational_attributes` to `ldap_operational_attribute`, matching
  the documented CLI/env option `--ldap-operational-attribute`, so the
  configured operational-attribute list is actually applied. Also strip
  `dn` unconditionally from entries before `ldap.add`, preventing
  `LDAP add error: UndefinedTypeError: dn` failures when the operational
  attribute list is misconfigured
- `core/twake/cozyProvision`: destroy the Cozy instance on SCIM delete
  via `DELETE /instances/<domain>` on the Cozy admin API before
  publishing the `b2b` / `domain.user.deleted` event. A 404 is treated
  as success so the lifecycle stays idempotent, and the b2b event is
  emitted even when the destroy fails so peer instances still drop
  their contact cards. Avoids leftover instances silently re-attaching
  on re-import
- `core/twake/cozyProvision`: set `OIDCID` on `POST /instances` to the
  SCIM `userName`, so the OIDC callback no longer fails with
  `Invalid sub: <sub> != ""` for SCIM-provisioned users

### Build

- Docker image now uses `node:24-alpine` instead of `node:22-alpine`

### Dependencies

- Update `express-rate-limit` to 8.5.2, `fast-xml-builder` and other
  transitive deps

## v0.3.4 (2026-05-05)

### Bug Fixes

- `core/twake/cozyProvision`: a series of fixes so SCIM-provisioned
  users land on a usable Cozy instance

## v0.3.3 (2026-05-05)

### Bug Fixes

- `core/scim`: pass hook payloads as spread args to `launchHooks`
  instead of wrapping them in an array. SCIM `*done` hooks
- `core/twake/cozyProvision`: rename the user identifier in the
  `auth/user.created` message body from `sub` to `twakeId`

## v0.3.2 (2026-05-04)

### New Features

- New plugin `core/twake/cozyProvision`: hooks the SCIM lifecycle to
  provision a Cozy instance after user creation and to publish
  `auth` / `user.created` and `b2b` / `domain.user.deleted` events
  on RabbitMQ.
- New plugin `core/auth/authzPerRoute`: restricts requests by HTTP method
  and path glob based on `req.user`

### Tests

- Widen TTL margins in `cache-manager` tests to deflake CI

## v0.3.1 (2026-04-29)

### New Features

- OpenAPI generator now parses `@openapi` and `@openapi-component`
  YAML directives in route JSDoc, so plugins are self-documenting
  (summary, description, parameters, requestBody, responses, security,
  tags, reusable component schemas via `$ref`)
  - it skips routes that have no `@openapi` block and logs a
    `Skipping undocumented route` warning, so the published
    reference reflects intentionally-documented endpoints only
  - it now recognises `TwakePlugin` and `AuthzBase` descendants and
    walks `src/abstract/`, covering the James plugin and the generic
    `LdapFlat` CRUD surface (with a `{resource}` path placeholder)
- Annotate every API-exposing plugin with OpenAPI metadata: SCIM 2.0
  (Users, Groups, Bulk, Discovery), `ldapOrganizations`, `ldapGroups`,
  `ldapPasswordPolicy`, `ldapBulkImport`, `twake/appAccountsApi`,
  `twake/james`, `static`, `configApi`, `hello/helloworld`,
  `authzDynamic`, plus the abstract `LdapFlat` routes — 51 operations
  across 10 tags, backed by 30 component schemas

### Documentation

- Add `docs/plugin-development/openapi.md` guide explaining the
  generator contract and the YAML directives
- Fix broken link to `hooks.md` in README

### Bug Fixes

- Rename `core/ldap/organization` plugin source file to
  `organizations.ts` so the documented plugin name
  `core/ldap/organizations` actually loads; keep the singular path
  as a deprecated alias that emits a one-time warning at module load
  (slated for removal at the next major release)
- Word the plugin-path deprecation warning around the plugin path
  itself, not around the loading entry point (`DM_PLUGINS`)

### Security

- Harden DN handling and LDAP filter escaping in the
  `ldapOrganizations` plugin:
  - `moveOrganization` now uses `getRdn()` / `isChildOf()` instead of
    `dn.split(',')[0]` and `endsWith()`, so escaped commas,
    multi-valued RDNs and attribute-name casing differences no longer
    bypass the descendant / same-location checks
  - Replace `topOrg.replace(/^ou=[^,]+,/, '')` with `getParentDn()` in
    both call sites, going through the existing DN parser
  - `escapeLdapFilter()` the request-controlled `dn` and `objectClass`
    query parameter in `getOrganisationSubnodes`, and the path segment
    in `checkDeptPath`, closing LDAP filter injection vectors
  - Throw `NotFoundError` / `BadRequestError` / `ConflictError`
    instead of plain `Error`, so HTTP responses carry meaningful 4xx
    codes (404 / 400 / 409) instead of a generic 500
  - Stop double-wrapping caught LDAP errors that would otherwise lose
    their original status code
- `ConfigApi.getTop` now points at `/v1/ldap/organizations/top` (the
  actual GET route) instead of the collection root that only accepts
  POST

## v0.3.0 (2026-04-25)

### New Features

- Add `core/scim` plugin: SCIM 2.0 identity provisioning endpoint
  (`/scim/v2/Users` and `/scim/v2/Groups`), with per-tenant LDAP base
  resolution via `--scim-user-base-template` / `--scim-group-base-template`
- Add `core/auth/authzDynamic` plugin: bearer-token authentication and
  per-branch authorization sourced from a dedicated LDAP branch, with
  in-memory cache (TTL + optional reload endpoint), constant-time
  password verification, and `AsyncLocalStorage`-scoped ACL enforcement
  on every downstream LDAP operation

### Security

- Enforce base-DN scope in `LdapFlat` operations: full DNs must be a
  direct child of the configured base, blocking sibling-branch access
  via crafted DNs
- Reject escaped-comma DN injection in `LdapFlat.resolveDn`: the parent
  DN check now uses parsed RDN components, so payloads like
  `cn=pwn\,ou=titles,ou=…` can no longer bypass a textual suffix check
- Detect DNs by `mainAttribute=` prefix instead of looking for a comma,
  so RDN values that legally contain commas (e.g. `Smith, John`) are no
  longer misclassified as DNs
- Address CodeQL and Copilot findings on the SCIM and authzDynamic
  plugins
- Update dependencies

## v0.2.2 (2026-04-08)

### New Features

- Update Twake-Drive plugin to be add a data deletion method

### Security

- Update dependencies

## v0.2.1 (2026-03-02)

### Bug Fixes

- Fix Twake Drive plugin authentication: use Basic Auth instead of Bearer token
  for Cozy Admin API compatibility

## v0.2.0 (2026-03-02)

### New Features

- Add `twake/drive` plugin for Twake Drive (Cozy) integration:
  - Propagate email address changes to Twake Drive via Admin API
  - Propagate display name changes with fallback logic (displayName → cn → givenName+sn)
  - Propagate disk quota changes (`twakeDriveQuota` attribute)
  - Support domain template for flexible domain generation (e.g., `{uid}.company.cloud`)
  - Public methods: `blockInstance()`, `unblockInstance()`, `syncUserToCozy()`,
    `getCozyDomain()`, `getDisplayNameFromDN()`, `getMailFromDN()`, `getDriveQuotaFromDN()`
  - Add `onLdapDriveQuotaChange` hook for drive quota change detection
  - Add `--drive-quota-attribute` configuration option

### Security

- Update dependencies
- Add domain validation to prevent URL injection attacks in Twake Drive plugin
- Add warning log when authentication token is not configured for Twake plugins

### Documentation

- Add comprehensive documentation for Twake Drive plugin

## v0.1.9 (2026-02-23)

### Security

- Add `escapeDnValue()` to all DN constructions to prevent LDAP injection attacks
- Add `validateDnValue()` to reject control characters and invisible Unicode in DN values
- Fix DN extraction regex to properly handle escaped commas

### New Features

- Export `escapeDnValue`, `escapeLdapFilter`, and `validateDnValue` utilities for plugins

### Tests

- Add comprehensive test suite for LDAP DN utilities (31 tests)

## v0.1.8 (2026-02-09)

### New Features

- Add `deleteUserData` method to James plugin for GDPR data deletion
- Add `deleteUserData` method to Calendar Resources plugin for GDPR data deletion

### Maintenance

- Update dependencies
- Fix lint errors and improve TypeScript typing

## v0.1.7 (2025-01-20)

### New Features

- Add `passwordPolicy` plugin for OpenLDAP ppolicy administration

### Improvements

- Add race condition protection to LDAP connection pool cleanup
- Fix memory leak in Modal: use DisposableComponent for event cleanup
- Add log before rejections
- Add some standard schemas (automountMaps, devices, dhcpHosts, dnsRecords,
  netgroups, posixAccounts, posixGroups, sshPublicKeys, sudoRules)

### Maintenance

- Update dependencies and require diff>=8.0.3
- Fix links in documentation
- Improve TypeScript exports

## v0.1.6 (2025-12-01)

- Export ldapActions types

## v0.1.5 (2025-12-01)

- Improve documentation and exports

## v0.1.4 (2025-11-29)

- Optimization & security
- Improve tests

## v0.1.3 (2025-11-25)

- Add plugin `core/auth/trustedProxy` - use `Auth-User` header when set
- Improve error reporting with proper HTTP codes
- User quota usage feature into James plugin

## v0.1.2 (2025-11-07)

- Run Docker container as non-root user
- Fix load order to keep logs
- Fix dependencies

## v0.1.1 (2025-11-05)

- Fix exports
- Export all utils
- Add SECURITY.md

## v0.1.0 (2025-11-03)

- New plugins
- Multiple LDAP URLs
- Add robust error handling to prevent server crashes
- Expose configuration via configApi
- Add Docker Swarm example
- Add log level "notice"
- Add OBM schemas
- Export abstract classes in package.json
- Remove dead code from ldapActions and ldapFlat
- Fix embedded LDAP server timing and reliability in tests

## v0.0.1 (2025-10-16)

- **Initial release**
