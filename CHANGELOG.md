# Changelog

## Unreleased

### Fixed

- SCIM: a `filter` nested more than 32 levels deep is answered 400
  `invalidFilter`, where the server answered 500
  ([#471](https://github.com/linagora/ldap-rest/issues/471))
- SCIM PATCH: an operation that is not an object, an `op` that is not a
  string, an empty attribute name and a value nested too deeply are
  answered 400, where they were answered 500; the same for a Bulk body
  nested too deeply
  ([#480](https://github.com/linagora/ldap-rest/issues/480),
  [#481](https://github.com/linagora/ldap-rest/issues/481))
- SCIM POST/PUT: a body is checked against RFC 7643 before anything is
  written or any hook runs. `userName`, `displayName` and `id` must be
  strings; a simple attribute takes a string, a number or a boolean, or a
  list of them; a complex attribute takes an object and a multi-valued one
  a list of objects whose `value` is a scalar. An object or a list of
  objects in a simple attribute, which was stored as `[object Object]` or
  as JSON text, is refused with 400 `invalidValue`: a custom mapping that
  put a complex attribute on a plain `ldap` attribute stops working
  ([#479](https://github.com/linagora/ldap-rest/issues/479))
- SCIM: a sub-attribute path naming an inherited property (`name.toString`)
  is an unknown path, where it reached the directory as a function's
  source ([#482](https://github.com/linagora/ldap-rest/issues/482))
- SCIM: `excludedAttributes` naming every sub-attribute of a multi-valued
  attribute drops the elements it leaves empty, as `attributes` does
  ([#483](https://github.com/linagora/ldap-rest/issues/483))

## v1.2.0 (2026-10-28)

Five changes need a check before deploying,
[upgrading](docs/usage/upgrading.md#from-11-to-120).

### Breaking Changes

- An exception nothing caught ends the process with 1, where it kept
  serving in an unknown state ([#423](https://github.com/linagora/ldap-rest/issues/423))
- `--ldap-dn` and `--ldap-pwd` have no default: the server stops at startup
  without them, and the Docker image no longer carries `admin` in its `ENV`
  ([#431](https://github.com/linagora/ldap-rest/issues/431))
- Every entity route, flat, group and organization, checks the shape of a
  value the same way and answers 400 where it wrote what it was sent: a
  list for a single-valued attribute, text for a `number`, the deletion of
  a `required` attribute, an undeclared attribute or a `fixed` one in a
  change; `null` clears an attribute in a `replace` and is refused
  elsewhere, where it answered 500; a group creation writes its `fixed`
  attributes at their default ([#416](https://github.com/linagora/ldap-rest/issues/416), [#448](https://github.com/linagora/ldap-rest/issues/448))

### Features

- On `SIGTERM` and `SIGINT`, the server leaves the endpoints, finishes what
  is in flight within `--shutdown-timeout` (20 s), closes the broker, the
  storage backend and the directory connections, then ends; `/readyz`
  answers `stopping` meanwhile, [docs](docs/usage/operations.md#shutdown)
  ([#423](https://github.com/linagora/ldap-rest/issues/423))
- `GET /healthz` and `GET /readyz`, outside the API prefix and without
  authentication: `/readyz` answers 200 once the plugins are loaded and the
  directory answers, 503 otherwise; `storage`, `rabbitmq`, `james` and
  `migrationProxy` report their backend there, `degraded` when it cannot be
  reached. The Helm chart probes them over HTTP,
  [docs](docs/usage/operations.md#health-and-readiness) ([#423](https://github.com/linagora/ldap-rest/issues/423))
- `core/metrics` serves Prometheus metrics on `--metrics-port` (9464): the
  requests, the directory operations, the pool, the cache, the calls to
  Twake, the Cloudery, cozy-stack and CrowdSec, the hooks that fail and the
  process; the Helm chart exposes the port and renders a `ServiceMonitor` on
  request. A plugin of your own calls its services through `this.fetch` to
  be counted, [docs](docs/usage/operations.md#metrics) ([#423](https://github.com/linagora/ldap-rest/issues/423))
- Every answer carries an `X-Request-Id`, and every line logged while the
  request is served carries it as `requestId`; a line a hook writes names
  its plugin and the hook, [docs](docs/usage/operations.md#request-id)
  ([#423](https://github.com/linagora/ldap-rest/issues/423))
- `core/twake/migrationProxy` keeps the migrated-users list of the Twake
  Mail migration proxy in step with the entries of
  `--migration-proxy-branch`: an entry gaining its mail is put on the list
  with its addresses, the addresses of a migrated one follow it, a deleted
  one is taken off; `GET /api/v1/users/:user/mail-migration` says where an
  account lives, [docs](docs/usage/plugins/integrations/mail-migration.md)
  ([#466](https://github.com/linagora/ldap-rest/issues/466))
- The Twake plugins take their webadmin URL with a trailing slash

### Fixes

- On every route, a `required` number takes `0` and a `required` boolean
  `false`; they were refused as missing ([#416](https://github.com/linagora/ldap-rest/issues/416))
- A group schema declaring an `array` attribute without `items` no longer
  makes every creation answer 500 ([#448](https://github.com/linagora/ldap-rest/issues/448))
- `ldap/bulkImport`: a row with a value under a `fixed` attribute of the
  schema fails, where the value replaced the fixed one,
  [docs](docs/usage/plugins/ldap/bulk-import.md#fixed-attributes)
  ([#445](https://github.com/linagora/ldap-rest/issues/445))
- The flat routes write the classes of the entity on a creation whatever
  `objectClass` the request carried, as the organization routes do
  ([#441](https://github.com/linagora/ldap-rest/issues/441))
- `--logger` takes `console` or `file`; an empty value is `console`, any
  other stops the server at startup,
  [upgrading](docs/usage/upgrading.md#--logger-console-or-file) ([#432](https://github.com/linagora/ldap-rest/issues/432))
- Organizations write the `fixed` attributes of their schema at their
  default on a creation and refuse them in a change, as groups and the flat
  routes do ([#430](https://github.com/linagora/ldap-rest/issues/430))
- The flat routes check an empty string against the schema, and every
  route refuses an empty DN for a pointer attribute; `[]` in a `replace` is
  still how an attribute is cleared ([#429](https://github.com/linagora/ldap-rest/issues/429))
- `core/rabbitmq`: SIGTERM and SIGINT end the process once the broker
  connection is closed, or after 10 seconds; a pod lived on until the end
  of its grace period ([#425](https://github.com/linagora/ldap-rest/issues/425))
- `core/rabbitmq`: its client's lines are server lines under
  `plugin: rabbitmq`, following `--logger` and `--log-level`; they went to
  standard output in the client's own format ([#465](https://github.com/linagora/ldap-rest/pull/465))
- `--logger file`: a line's `error` follows its message; it was dropped
  ([#465](https://github.com/linagora/ldap-rest/pull/465))
- The error middleware and the routes answering through `serverError` send
  the same 5xx body; `--debug` names the failure in it on both paths,
  `DM_DEBUG` is read, and `--debug` no longer takes the next argument as
  its value ([#426](https://github.com/linagora/ldap-rest/issues/426))
- `groups`, `organizations` and `flatGeneric` announce their schema file
  (`schemaUrl` in `GET /config`) at the URL where a static plugin serves it
  merged, as SCIM does since 1.1.0, and leave it out where none does
  ([#413](https://github.com/linagora/ldap-rest/issues/413))

## v1.1.0 (2026-10-25)

Two changes need a check before deploying,
[upgrading](docs/usage/upgrading.md#from-10-to-110).

### Security

- `core/static`: the files it serves cannot be framed by another origin
  (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`); a portal that
  frames them must be named with `--static-csp` and
  `--static-frame-options`,
  [docs](docs/usage/plugins/utilities/static.md#security-headers). Every
  response carries `X-Content-Type-Options: nosniff`, none `X-Powered-By`
  ([#407](https://github.com/linagora/ldap-rest/issues/407),
  [#409](https://github.com/linagora/ldap-rest/pull/409))

### Breaking Changes

- An empty `--static-name` is `static`, as announced, not the root; a name
  Express would not match as written stops the server at startup
  ([#409](https://github.com/linagora/ldap-rest/pull/409))

### Fixes

- SCIM's schema files (`schemaUrls` in `GET /config`) are announced at the
  URL of the static plugin serving them, which `--static-name` or
  `--schemas-path` could make answer 404
  ([#411](https://github.com/linagora/ldap-rest/issues/411),
  [#412](https://github.com/linagora/ldap-rest/pull/412))

## v1.0.1 (2026-10-25)

### Security

- `/logout` (`core/auth/openidconnect`) ends the session here, not only the
  browser's copy: with `core/bcl` loaded, it records the session it ends,
  and a copy of the cookie is refused instead of working until its tokens
  expire. Without `core/bcl`, the first `/logout` warns that it cannot,
  [docs](docs/usage/plugins/auth/oidc.md#logout)

## v1.0.0 (2026-10-24)

Authorization fails closed: every operation made for a request is judged
as its caller unless made as the server (`ldap.system`), and a write is
judged before the route looks in the directory. The public API is declared
stable, [docs](docs/README.md#api-stability). Breaking changes since 0.26:
[upgrading](docs/usage/upgrading.md#from-026-to-100).

### Security

- An operation made while serving a request is judged as its caller, even
  when the code did not hand the request down; `ldap.system` makes one as
  the server, hooks act as the server (`authzDynamic` included), and a lint
  rule refuses an operation naming neither,
  [docs](docs/plugin-development/README.md#using-ldap-operations). The
  server refuses to start with an authorization plugin and no
  authentication plugin, which let every request through,
  [docs](docs/usage/plugins/auth/README.md#what-is-refused-at-startup)
  ([#390](https://github.com/linagora/ldap-rest/pull/390),
  [#391](https://github.com/linagora/ldap-rest/pull/391))
- The authorization plugins judge before any other plugin: the trash let a
  caller delete what they could not write, `enterpriseRules` answered 409
  where the caller had no right
  ([#378](https://github.com/linagora/ldap-rest/pull/378))
- A write is judged before the route looks in the directory, so a caller
  without the right gets the same 403 whether the entry exists or not:
  renames, flat entries, groups, organizations, moves, tombstones, app
  accounts; creating a group no longer creates its external members before
  it is judged. A bulk import row the caller may not write reports that
  refusal, whether its entry exists, in a dry run or not,
  [docs](docs/usage/plugins/ldap/bulk-import.md#authorization)
  ([#381](https://github.com/linagora/ldap-rest/pull/381),
  [#384](https://github.com/linagora/ldap-rest/pull/384))
- `authzPerBranch`: the most specific branch rule applies, whatever the
  order the rules are written in, in reads, writes and searches — a
  restriction on a sub-branch was ignored; `default` no longer overrides a
  rule refusing a permission; a branch cannot be renamed or moved out of a
  rule, nor created, by a caller it refuses; setting the organization link
  along with other changes needs write where the entry stands (read was
  enough); branches are compared as DNs, however spelled,
  [docs](docs/usage/plugins/auth/authz-per-branch.md#permission-resolution)
  ([#388](https://github.com/linagora/ldap-rest/pull/388))
- The organization link escaped the move check when spelled in another
  case, under its OID or an alias, added rather than replaced, or given
  several values: an account or a group could be attached to an
  organization the caller may not write. It is read under any name, adding
  one is judged as a move, and several or empty values are refused. Every
  write names its attributes as the server does: an option other than
  `;binary`, one attribute named twice, or a rename to an RDN naming
  another attribute or holding several values is refused (400); route checks find schema attributes
  whatever their case (fixed attributes, group members)
  ([#384](https://github.com/linagora/ldap-rest/pull/384),
  [#405](https://github.com/linagora/ldap-rest/pull/405))
- `twake/groups`: any caller got the groups and member profiles of every
  organization; the routes read as the caller, and under an attachment
  model a group carries its organization's link
  ([#383](https://github.com/linagora/ldap-rest/pull/383))
- SCIM: a member given by DN was taken as it stood, so a caller could put
  in its group an account it may not read; it is looked up as the caller.
  A DN is compared to the user base RDN by RDN
  ([#401](https://github.com/linagora/ldap-rest/pull/401))
- Routes no longer tell whether an entry exists where the caller cannot
  read it: quota and app accounts, `raw` children and search, SCIM
  `PUT /Users/{id}`. Uniqueness (409) and schema pointers still answer
  about the whole directory, by design
  ([#381](https://github.com/linagora/ldap-rest/pull/381),
  [#393](https://github.com/linagora/ldap-rest/pull/393),
  [#401](https://github.com/linagora/ldap-rest/pull/401))

### Fixes

- `enterpriseRules`: re-saving an unchanged value no longer conflicts with
  the entry's applicative copy (409); a rule applies whatever the spelling
  of the attribute, and a move rechecks the mail domains
  ([#402](https://github.com/linagora/ldap-rest/issues/402),
  [#404](https://github.com/linagora/ldap-rest/pull/404))
- `organizations`: `/subnodes` and `/subnodes/search` answered 403 to an
  administrator held to their organization; deleting `OU=…` skipped the
  emptiness check
  ([#403](https://github.com/linagora/ldap-rest/issues/403),
  [#405](https://github.com/linagora/ldap-rest/pull/405))
- `groups`: a name with a comma that is no DN answers 400 (500 before); a
  DN outside the groups branch answers 404, where it was read and written
  as a group; the update route no longer writes the attributes the schema
  fixes
  ([#399](https://github.com/linagora/ldap-rest/pull/399),
  [#405](https://github.com/linagora/ldap-rest/pull/405))
- Shipped schemas: a mail domain or nomenclature value still referenced is
  not deleted (409); a schema whose branch is absent no longer refuses
  every delete
  ([#398](https://github.com/linagora/ldap-rest/pull/398))
- `james`: a mailbox type pointer written `CN=TeamMailbox,…` skipped the
  team mailbox checks
  ([#405](https://github.com/linagora/ldap-rest/pull/405))
- `passwordPolicy`: unlocking a user that is not there answered 500 (404)
  ([#393](https://github.com/linagora/ldap-rest/pull/393))
- `externalUsersInGroups` refuses an external member in any mail domain the
  directory declares, listed in `GET /config` (`managedDomains`),
  [docs](docs/usage/plugins/ldap/external-users.md#important-notes)
  ([#379](https://github.com/linagora/ldap-rest/pull/379))
- The search cache no longer keeps `memberOf` stale after a membership
  change, [docs](docs/usage/configuration.md#the-search-cache)
  ([#377](https://github.com/linagora/ldap-rest/pull/377)); UTF-8
  hex escapes in DNs are decoded
  ([#376](https://github.com/linagora/ldap-rest/pull/376))

### Features

- `--app-accounts-user-attribute` sets the attribute the app account routes
  match `:user` against
  ([#400](https://github.com/linagora/ldap-rest/pull/400))

## v0.26.0 (2026-10-23)

### Features

- `user.created`, published by `core/twake/instances`, carries the
  account's Matrix ID (`matrixId`, `@local:domain` from its `mail`), which
  cozy-stack stores instead of deriving it from the instance's email,
  [docs](docs/usage/plugins/integrations/instances.md#providers)
  ([#375](https://github.com/linagora/ldap-rest/pull/375))

## v0.25.1 (2026-10-23)

### Fixes

- Removing the last member of a group through the API leaves the
  placeholder (`--group-dummy-user`) in its place, instead of a generic
  409; without a placeholder, the 409 says a group needs one member,
  [docs](docs/usage/plugins/ldap/groups.md#remove-member)
  ([#373](https://github.com/linagora/ldap-rest/pull/373))

## v0.25.0 (2026-10-23)

### Features

- `GET /password-policies` also answers the `attributes` a policy can be
  given, those the directory's schema defines (OpenLDAP 2.4 lacks some),
  [docs](docs/usage/plugins/ldap/password-policy.md#managing-policies)
  ([#366](https://github.com/linagora/ldap-rest/pull/366))
- `GET /authz/scope` says whether the caller may list the password
  policies (`passwordPolicies`), so a client no longer has to ask and be
  refused,
  [docs](docs/usage/plugins/ldap/password-policy.md#managing-policies)
  ([#371](https://github.com/linagora/ldap-rest/pull/371))
- The common refusals carry a `code` (`unique`, `mailDomain`, `forbidden`)
  and the `attribute`, `value` or `domains` at fault, next to their message;
  the bulk import reports them per row,
  [docs](docs/client-development/api/rest-api.md#error-response-format)
  ([#372](https://github.com/linagora/ldap-rest/pull/372))
- `--authz-transit-origin-attribute` records the organization an entry put
  in transit leaves, and removes it when the entry is claimed,
  [docs](docs/usage/plugins/auth/authz-linid1.md#where-an-entry-comes-from)
  ([#370](https://github.com/linagora/ldap-rest/pull/370))

### Fixes

- The mail domain refusal lists a domain linked at several levels once
  ([#350](https://github.com/linagora/ldap-rest/issues/350))

### Security

- Docker image rebuilt on the latest Node.js 24, for CVE-2026-105481,
  CVE-2026-105482, CVE-2026-105483, CVE-2026-106069, CVE-2026-106072,
  CVE-2026-106073 and CVE-2026-106074
- `ip-address` 10.7.4, for GHSA-rxp7-6hxx-x8q5

## v0.24.0 (2026-10-22)

### Features

- Schemas: `referentialIntegrity: "remove"` takes a deleted entry's DN out
  of the attribute, including when the entry is moved to the trash,
  [docs](docs/usage/plugins/ldap/enterprise-rules.md#deletion-and-references)
  ([#365](https://github.com/linagora/ldap-rest/pull/365))

### Fixes

- Twake schemas: deleting an account takes it out of the organizations it
  managed or administered, the mailboxes delegated to it, the groups and
  shared mailboxes it owned and the devices it owned or managed: an account
  created again with the same address inherited the old one's rights,
  [notes](docs/usage/upgrading.md#links-to-deleted-accounts)
  ([twake-directory-manager#101](https://github.com/linagora/twake-directory-manager/issues/101),
  [#365](https://github.com/linagora/ldap-rest/pull/365))
- `core/ldap/groups`: an entry moved to the trash leaves its groups, as a
  deleted one does; an entry created again with the same DN inherited its
  memberships, [docs](docs/usage/plugins/ldap/trash.md#limitations)
  ([#365](https://github.com/linagora/ldap-rest/pull/365))

## v0.23.0 (2026-10-22)

### Features

- Schemas: `help` says what an attribute is, for a client to show on demand
  next to its label,
  [docs](docs/usage/plugins/ldap/flat-generic.md#explaining-an-attribute-help)
  ([#364](https://github.com/linagora/ldap-rest/pull/364))
- Schemas: the roles `givenName` and `surname` name the parts of a person's
  name, which a client composes the `displayName` from; the shipped user
  schemas mark `givenName` and `sn`,
  [docs](docs/usage/plugins/ldap/flat-generic.md#semantic-roles)
  ([#364](https://github.com/linagora/ldap-rest/pull/364))
- Twake users: the Employee ID explains itself, and the Department comes
  right after it ([#364](https://github.com/linagora/ldap-rest/pull/364))

## v0.22.1 (2026-10-21)

### Fixes

- `core/auth/authzLinid1`: the administrators of
  `--authz-global-organization` link an organization to any mail domain, as
  those of the top organization do; where the top organization is a bare
  container, nobody could give a new organization a domain.
  `GET /authz/scope` reports it as `linksAnyDomain`,
  [docs](docs/usage/plugins/auth/authz-linid1.md#mail-domains)
  ([#363](https://github.com/linagora/ldap-rest/pull/363))

## v0.22.0 (2026-10-21)

### Features

- `twake/james`: the mail domains of the directory are created in James,
  and removed with their entry; a domain still linked by an organization,
  or with addresses at it, cannot be deleted,
  [docs](docs/usage/plugins/integrations/james-mail.md#mail-domains),
  [notes](docs/usage/upgrading.md#james-follows-the-mail-domains)
  ([#361](https://github.com/linagora/ldap-rest/pull/361))
- `core/auth/authzLinid1`: `--authz-global-write-branches` reserves the
  writes and deletes of branches outside the tree, such as the mail domains,
  to the administrators of `--authz-global-organization`, while every
  administrator keeps reading them,
  [docs](docs/usage/plugins/auth/authz-linid1.md#global-branches)
  ([#361](https://github.com/linagora/ldap-rest/pull/361))

## v0.21.3 (2026-10-20)

### Fixes

- `twake/james`: removing a user's quota, or setting it to `0`, deletes their
  James quota so that the domain or global one applies; it set a 0 byte
  quota, refusing every mail,
  [docs](docs/usage/plugins/integrations/james-mail.md#quota-changes)
  ([#360](https://github.com/linagora/ldap-rest/pull/360))

## v0.21.2 (2026-10-20)

### Features

- Twake schema `twake/teamMailboxes.json`: team mailboxes as an entity of
  their own, in `ou=teammailboxes`, which Twake Mail does not expand as lists,
  [docs](docs/usage/plugins/integrations/james-mailboxes.md#team-mailboxes-in-a-branch-of-their-own)
  ([#358](https://github.com/linagora/ldap-rest/pull/358))

### Fixes

- Flat entities: an attribute the schema marks `fixed` gets its `default` at
  creation, as documented; it was checked, then not written
- Creating an entry in a branch that does not exist answers `404`, naming
  the branch; it was a `500`

## v0.21.1 (2026-10-20)

### Security

- `core/ldap/passwordPolicy`: `GET /password-policy` and `GET /config`
  served the default policy to every caller, whatever the authorization
  plugins allow. The first is now judged like `/password-policies`; the
  second no longer carries it (`ldapPolicy`)
  ([#356](https://github.com/linagora/ldap-rest/pull/356))

### Features

- `core/auth/authzLinid1`: `--authz-global-branches` keeps branches outside
  the organization tree, such as the password policies, to the
  administrators of `--authz-global-organization` (the top organization by
  default), [docs](docs/usage/plugins/auth/authz-linid1.md#global-branches)

## v0.21.0 (2026-10-20)

### Breaking Changes

- `core/ldap/passwordPolicy`: with several policies and no
  `--ppolicy-default-dn`, none is taken as the default; it was the first one
  found, [notes](docs/usage/upgrading.md#several-password-policies)

### Features

- `core/ldap/passwordPolicy`: list, create, edit, delete and assign password
  policies, under the new `--ppolicy-base`
  ([docs](docs/usage/plugins/ldap/password-policy.md#managing-policies))
- Writes no longer read the entry first to repair its object classes: only a
  write the directory refuses is repaired, and shows as `err=65` in its logs
  ([details](docs/usage/plugins/ldap/flat-generic.md#entries-created-by-other-tools))

### Fixes

- `core/ldap/passwordPolicy`: password status and `expiring-soon` use each
  account's own policy (`pwdPolicySubentry`); status no longer fails with a
  500 on unlocked accounts, nor unlock with a 404; a policy without
  `pwdAllowUserChange` reads as `true`
- `twake/instances`, `twake/clouderyProvision`: an account another tool
  created without the class its instance address needs gets it, then its
  address and `user.created`. Accounts already blocked need a call,
  [notes](docs/usage/upgrading.md#accounts-another-tool-created)
  ([#348](https://github.com/linagora/ldap-rest/issues/348))

## v0.20.3 (2026-10-16)

### Security

- `core/ldap/accountLifecycle`: `POST /{entity}/{id}/password` and
  `/status` skipped the branch checks of `authzPerBranch` and `authzLinid1`:
  any authenticated caller could reset a password, and read the generated
  one, or change an account's state ([#339](https://github.com/linagora/ldap-rest/pull/339))

### Fixes

- Errors that answered 500 answer 400 or 404: a write to a missing entry or
  value, a DN that is not one, a JSON number or boolean (written as text, or
  `TRUE` / `FALSE`, where the schema declares a `number` or a `boolean`), a
  group member change sent through `PUT`, an impossible group move
  ([#332](https://github.com/linagora/ldap-rest/issues/332), [#333](https://github.com/linagora/ldap-rest/issues/333), [#334](https://github.com/linagora/ldap-rest/issues/334), [#335](https://github.com/linagora/ldap-rest/issues/335),
  [#347](https://github.com/linagora/ldap-rest/pull/347))
- A write whose body is not a JSON object answers 400; some routes did not
  answer at all ([#331](https://github.com/linagora/ldap-rest/issues/331))
- `PUT` on a flat entity, a group or an organization refuses a body naming no
  attribute, or holding keys other than `add`, `replace` and `delete`; it
  changed nothing and answered success ([#336](https://github.com/linagora/ldap-rest/issues/336))
- `POST /{entity}/{id}/password` refuses a password over 256 characters or
  holding a control character, and a `forceChange` that is not a boolean
  ([#337](https://github.com/linagora/ldap-rest/issues/337))
- `twake/instances`, `twake/clouderyProvision`: members whose `uid` holds
  characters such as `_` or `@` get an instance; two `uid`s reducing to the
  same slug cannot share one. Members already blocked need a call,
  [notes](docs/usage/upgrading.md#members-whose-uid-the-cloudery-refused-as-a-slug)
  ([#330](https://github.com/linagora/ldap-rest/issues/330))
- Returned entries no longer carry empty `*`, `+` and `1.1` keys
  ([#338](https://github.com/linagora/ldap-rest/issues/338))
- The bundled user, group and unit editors save what was changed, and the
  browser examples work again ([#342](https://github.com/linagora/ldap-rest/pull/342), [#347](https://github.com/linagora/ldap-rest/pull/347))

## v0.20.2 (2026-10-15)

### Fixes

- `twake/instances`: members of an organization created before 0.13.0 get
  their instance; those added before this fix need a call,
  [notes](docs/usage/upgrading.md#members-of-organizations-created-before-0130)
  ([#329](https://github.com/linagora/ldap-rest/pull/329))

## v0.20.1 (2026-10-14)

### Fixes

- `ldap/groups`: a raw `match` filter accepts `.`, `@` and `'`
  (linagora/twake-directory-manager#70)

## v0.20.0 (2026-10-13)

### Breaking Changes

- `twake/james`: a team mailbox only takes members whose address is at its
  domain (linagora/twake-directory-manager#66);
  `--james-team-mailbox-any-domain` lifts the rule,
  [notes](docs/usage/upgrading.md#team-mailboxes-keep-their-members-to-their-domain)

## v0.19.1 (2026-10-13)

### Fixes

- `ldap/groups`: adding or removing members is authorized as a change to the
  group, and a member the caller cannot read is refused (#325)
- `ldap/passwordPolicy`: the per-user routes and the lists are authorized for
  the caller
- authorization plugins: a delegated administrator only links an
  organization to mail domains an organization above it links,
  [docs](docs/usage/plugins/auth/authz-linid1.md#mail-domains) (#325)

## v0.19.0 (2026-10-12)

### Breaking Changes

- `twake/james` no longer copies `--forward-attribute` to Twake Mail
  forwards, a user setting; `--james-sync-forwards` restores it,
  [notes](docs/usage/upgrading.md#forwards-are-no-longer-copied-to-twake-mail)

### Features

- Twake schemas: Mongolian (`mn`) texts,
  [docs](docs/usage/plugins/ldap/flat-generic.md#naming-things-in-the-readers-language)
- `ldap/externalUsersInGroups`: `/api/v1/config` publishes the external
  members branch, [docs](docs/usage/plugins/ldap/external-users.md#config-api)

### Fixes

- `ldap/externalUsersInGroups`: an escaped address is stored unescaped,
  member DNs and managed domains are compared case-insensitively, and only
  direct children of the branch count
- `twake/james`: team mailboxes are created, named by the local part of their
  address,
  [docs](docs/usage/plugins/integrations/james-mailboxes.md#team-mailboxes)
- `twake/james`: a renamed account keeps its default identity and signatures,
  [docs](docs/usage/plugins/integrations/james-mail.md#mail-address-changes)
- `twake/james`: an address an account takes loses the forwards a former owner
  left, [docs](docs/usage/plugins/integrations/james-mail.md#forwards-left-on-an-address)
- `twake/james`: a mail added to an existing entry is provisioned as at
  creation

## v0.18.0 (2026-10-12)

### Breaking Changes

- `twake/james` no longer copies mailing lists to James address groups: Twake
  Mail reads them from LDAP with its `LDAPMailingList` mailet. The address
  groups already created must be deleted,
  [notes](docs/usage/upgrading.md#mailing-lists-are-no-longer-copied-to-james)
- Twake schemas: `hint` and `group` are maps keyed by language tag, like
  `label`, and any schema may write them so. A client reading them as strings
  must be upgraded,
  [notes](docs/usage/upgrading.md#the-twake-schemas-translate-their-hints-and-form-sections),
  [docs](docs/usage/plugins/ldap/flat-generic.md#naming-things-in-the-readers-language)

### Fixes

- A refused attribute is reported as `Attribute "x" …` on every route, with
  the English `hint` of the schema for an invalid value
- `ldap/groups`: a value of the wrong type, or a member that does not exist,
  answers 400 instead of 500,
  [docs](docs/client-development/api/rest-api.md#add-group-member)
- An empty list clears an attribute on a replace, on every route; on an add or
  a creation it answers 400 instead of 500
- `twake/james`: a group with a `mail` is no longer handled as a user,
  [docs](docs/usage/plugins/integrations/james-mail.md#groups)
- `twake/james`: a team mailbox follows its group (members, type, address,
  deletion), not only its creation,
  [docs](docs/usage/plugins/integrations/james-mailboxes.md#following-the-group)
- `twake/groups.json`, `standard/groups.json`: a group's `owner` may be any
  entry under the base, as `member` may
- Twake nomenclature schemas: `cn` and `description` have English and French
  labels
- `twake/nomenclature/twakeDomain.json`: a mail domain can be named by its
  `associatedDomain`
- Flat entities: reading one entry returns the operational attributes its
  schema declares, such as `memberOf`,
  [docs](docs/usage/plugins/ldap/flat-generic.md#attributes-a-client-may-not-send)

## v0.17.1 (2026-10-10)

### Fixes

- `twake/james`: the calls James refuses while its LDAP replica lags behind
  the write (rename, quota, alias, forward, delegation, identity) are retried,
  see `--james-retry-attempts` and `--james-retry-delay`,
  [docs](docs/usage/plugins/integrations/james-mail.md#replication-lag)
- `twake/james`: a team mailbox is created before its members are added
- `ldap/onChange`: deleting a user fires the mail hook only; its James data is
  kept
- `ldap/organizations`: the GET of an organization that does not exist
  answers 404 instead of 500
- A plugin module requested twice is loaded once, and a failed load can be
  tried again

## v0.17.0 (2026-10-09)

### Breaking Changes

- `--quota-attribute` (`DM_QUOTA_ATTRIBUTE`) defaults to `mailQuotaSize`, the
  quota attribute of the Twake schemas, instead of `mailQuota`: `twake/james`
  now pushes to Twake Mail the quota the console edits. A deployment whose
  quota lives in `mailQuota` must now set `DM_QUOTA_ATTRIBUTE=mailQuota`; one
  that already sets the option keeps its value,
  [notes](docs/usage/upgrading.md#the-quota-attribute-defaults-to-mailquotasize)

### Features

- Schemas: a schema file can `extends` another one, shipped
  (`"extends": "ldap-rest:twake/users.json"`) or not, and hold only its
  differences; `null` removes a key, such as an attribute. Applies to every
  schema option, and `core/static` serves the merged schema,
  [docs](docs/client-development/schemas/README.md#extending-a-schema)

### Fixes

- Twake schemas: the user schema no longer offers `mailQuota`, which the
  Twake directory schema does not define: a value typed there made the
  directory refuse the whole change. The mailbox quota is `mailQuotaSize`
- A write the directory refuses for its content (an attribute its schema
  does not define, a value of the wrong syntax, a missing mandatory
  attribute, a naming rule) answers 400 with the directory's diagnostic
  instead of 500; a modify adding a value the entry already holds, and a
  rename or a move onto a DN already taken, answer 409,
  [docs](docs/client-development/api/rest-api.md#400-bad-request)
- `core/static`: a schema file configured outside `--static-path` is served at
  the `schemaUrl` the configuration API gives for it, instead of the shipped
  schema of that URL or a 404
- `core/static`: a schema two directories deep or more
  (`schemas/twake/nomenclature/`), or with a dot in its name
  (`my.schema.json`), is served with its placeholders replaced instead of as
  a raw file, and a file under `schemas/` that is not JSON is served instead
  of refused

## v0.16.2 (2026-10-09)

### Features

- `ldap/organizations`: `GET /api/v1/ldap/organizations/:dn/search?q=` searches
  the organizations of a whole subtree, at any depth, by name, description and
  path, for a department autocomplete over a wide tree. Bounded by
  `--ldap-organization-max-subnodes`; a final `moreIndicator` row marks a
  partial answer and tells the cap from a directory size limit. Advertised as
  `endpoints.search` by the config API,
  [docs](docs/client-development/api/rest-api.md#search-organizations-in-a-subtree)

## v0.16.1 (2026-10-07)

### Fixes

- `twake/james`: the display name goes to the user's default identity,
  created when missing, instead of the server-set one, which made Twake Mail
  add a second identity named "givenName sn",
  [docs](docs/usage/plugins/integrations/james-mail.md#display-name-and-identity)
- `ldap/onChange`: a change of the display name attribute alone
  (`--display-name-attribute`, `displayName` by default) fires
  `onLdapDisplayNameChange`

## v0.16.0 (2026-10-07)

### Breaking Changes

- `twake/spaces`: with `--rabbitmq-url` and `--twake-group-organization-dn`,
  the server does not start when the directory schema does not define the
  organization domain attribute,
  [notes](docs/usage/upgrading.md#space-events-need-the-organization-domain-attribute)

### Security

- Build: fast-glob is replaced with tinyglobby, which drops braces and its
  unpatched advisory GHSA-vfj7-8cjw-p6xm

### Features

- `twake/spaces`: space events carry `organizationDomain`, read from
  `--twake-instance-organization-domain-attribute` (default `twakeDomain`),
  [docs](docs/usage/plugins/integrations/spaces.md#events)
- `twake/spaces`: space sync. On `twake.space.sync.requested`, read from
  `--twake-space-sync-queue`, the plugin publishes a space, an organization or
  every organization as `twake.space.synced`, then
  `twake.space.sync.completed`,
  [docs](docs/usage/plugins/integrations/spaces.md#sync)

### Fixes

- `twake/groups`: the search also matches the `cn` of a group without a
  display name ([#289](https://github.com/linagora/ldap-rest/issues/289))
- `ldap/organizations`: the subnode search also matches the user's display
  name ([#290](https://github.com/linagora/ldap-rest/issues/290))

## v0.15.0 (2026-10-06)

### Breaking Changes

- Array options: a value given on the command line replaces the default
  instead of being added to it,
  [notes](docs/usage/upgrading.md#an-array-option-on-the-command-line-replaces-its-default)
- Array options from the environment are split according to what they hold:
  a DN option splits on `;` only, `--auth-hmac` and `--auth-totp` never on
  spaces, and an empty variable keeps the default; the plural command-line
  form splits on `;` before `,`,
  [notes](docs/usage/upgrading.md#to-0150)
  ([#284](https://github.com/linagora/ldap-rest/issues/284))
- The server refuses to start on an HMAC or TOTP entry that cannot work, an
  empty `DM_LDAP_URL`, or a number option that is not an integer,
  [notes](docs/usage/upgrading.md#an-empty-environment-variable-or-a-number-that-is-not-one)

### Security

- `core/auth/totp`: an entry whose digits field was not a number registered
  a user whose code was the string `NaN`, so `Bearer NaN` authenticated; such
  an entry now stops the server
  ([#284](https://github.com/linagora/ldap-rest/issues/284))
- proxy-addr 2.0.8: behind `--trusted-proxy`, an IPv4-mapped IPv6 address
  could pass for a trusted subnet (GHSA-jqcg-44mw-7w3h); http-cache-semantics
  4.3.0 (GHSA-ch52-4w7c-c8xp)
- `lsc-plugin`: jackson-databind 2.22.3 (CVE-2026-19032, CVE-2026-68497,
  CVE-2026-83557, CVE-2026-91776, CVE-2026-91777)

### Features

- `core/twake/spaces`: spaces of an organization under
  `/api/v1/organizations/:id/spaces`, holding users and linked groups as
  viewer, editor or admin,
  [spaces](docs/usage/plugins/integrations/spaces.md):
  - `--twake-space-user-role-attribute` keeps each user's role in every space
    on their entry, as `<space id>:<role>`;
  - with RabbitMQ, changes are published as `twake.space.*` events on
    `--twake-space-exchange` (default `space`); without the role attribute,
    a role changed twice in quick succession may be announced twice or not
    at all;
  - when a space's last admin is deleted, its editors, or else its viewers,
    become admins, and a space left with no user of its own is deleted.

  It loads `core/ldap/onChange`. With the role attribute or RabbitMQ, it
  does not start when `core/ldap/trash` watches the group or space branches,
  nor when RabbitMQ cannot be reached.

### Fixes

- `core/twake/groups`: `?search=` with an empty value lists everything
  instead of answering 400; a request an authorization plugin refuses
  answers 403 instead of 500; moving a group to another organization with
  its members is refused
- `--group-class top,groupOfNames,twakeGroup` (comma-separated, singular
  form) no longer gives one invalid object class,
  [details](docs/usage/configuration.md#array-options)
- `core/twake/lifecycleEvents`: an operational attribute such as
  `entryUUID` named by a rule is published instead of left out,
  [rules](docs/usage/plugins/integrations/lifecycle-events.md#rules)

## v0.14.0 (2026-10-02)

### Breaking Changes

- `core/twake/instances`: `--twake-instance-organization-account` is removed,
  [notes](docs/usage/upgrading.md#--twake-instance-organization-account-is-removed)
  ([#262](https://github.com/linagora/ldap-rest/pull/262))

### Security

- `core/auth/hmac` refuses a GET, DELETE or HEAD carrying a body, which
  the signature did not cover, and a signed body under a charset other than
  UTF-8, which would be read as other characters —
  [notes](docs/usage/upgrading.md#hmac-refuses-a-body-it-does-not-sign)
  ([#257](https://github.com/linagora/ldap-rest/issues/257))

### Features

- Plugin API: `ldapmodifyend`, `ldapdeleteend` and `ldaprenameend` fire once
  a write is over, whatever became of it, with its operation number, which
  `currentOperation()` gives the request and "done" hooks of a modify, delete
  or rename: for a plugin that keeps something from one to the other —
  [hooks](docs/plugin-development/hooks.md#ldapmodifyend-ldapdeleteend-ldaprenameend)

- Plugin API: `registerBodyParser` runs a plugin's body parser ahead of the
  global ones and of authentication, and `jsonBodyParser` builds one that
  keeps the bytes `core/auth/hmac` checks —
  [plugin development](docs/plugin-development/README.md#parsing-request-bodies)

### Fixes

- Browser `HmacAuthClient`: `post`, `put` and `patch` send a string body as
  `application/json` unless the caller sets another `Content-Type`; it went
  as `text/plain` and was refused
  ([#259](https://github.com/linagora/ldap-rest/issues/259))

- `core/ldap/onChange` no longer keeps, for the life of the process, the
  entry it read before a write that never completed: a delete the trash or a
  tombstone takes over, and any modify, delete or rename refused by a hook
  or by the directory. After a refused rename, a later move of the entry no
  longer published a rename with that stale entry as its "before"
  ([#225](https://github.com/linagora/ldap-rest/issues/225))

- `core/scim` parses SCIM bodies only when it is loaded: without it, an
  `application/json` request under `--scim-prefix` is held to the global
  100 kB limit again, and an `application/scim+json` body is no longer read,
  so `core/auth/hmac` refuses it with `401`
  ([#268](https://github.com/linagora/ldap-rest/issues/268))

## v0.13.4 (2026-10-02)

### Features

- `core/twake/instances`: `--twake-instance-cloudery-offer` takes one offer
  per `--twake-instance-dn` expression, separated by `;` in the same order,
  see [instances](docs/usage/plugins/integrations/instances.md#configuration);
  a single offer still applies to every account
  ([#263](https://github.com/linagora/ldap-rest/issues/263))

## v0.13.3 (2026-10-02)

### Features

- `core/twake/instances`: `--twake-instance-organization-account` names an
  account of each organization that gets the organization instance's address,
  see [instances](docs/usage/plugins/integrations/instances.md#organizations)
  ([#255](https://github.com/linagora/ldap-rest/issues/255))

### Fixes

- `core/auth/hmac` hashes the body bytes received, as documented, instead of
  the body re-serialized with `JSON.stringify`: a request whose JSON is not
  serialized that way, or a form body, was refused —
  [notes](docs/usage/upgrading.md#hmac-hashes-the-body-bytes-received)
  ([#251](https://github.com/linagora/ldap-rest/issues/251))

- `core/scim`: `--scim-bulk-max-payload-size` applies to a SCIM request sent
  as `application/json` too; it was cut at body-parser's 100kb default and
  answered 413. The `application/scim+json` parser added in v0.13.1 now only
  covers the SCIM prefix

## v0.13.2 (2026-10-01)

### Security

- `core/auth/hmac`: the signature did not cover a body that no global parser
  had read — a `multipart/form-data` upload, a `text/plain` body — and such a
  request was accepted with whatever body it carried. It is refused now —
  [notes](docs/usage/upgrading.md#hmac-refuses-a-body-it-cannot-check)
  ([GHSA-j5c6-cg2q-vrfw](https://github.com/linagora/ldap-rest/security/advisories/GHSA-j5c6-cg2q-vrfw))

## v0.13.1 (2026-10-01)

### Fixes

- `core/auth/hmac` accepts a signed SCIM write sent as
  `application/scim+json`; it hashed an empty body and answered 401
  ([#246](https://github.com/linagora/ldap-rest/issues/246))
- `core/twake/tombstone`: the `deleted` event of a tombstoned entry carries
  the deleting request's `$context` (actor, request id, source); it had none
  ([#247](https://github.com/linagora/ldap-rest/issues/247))

## v0.13.0 (2026-10-01)

### Breaking Changes

- `core/auth/openidconnect`: a session ends with its access token, unless a
  refresh token renews it —
  [notes](docs/usage/upgrading.md#an-openid-connect-session-ends-with-its-access-token)
- `core/ldap/trash`: `--trash-watched-bases` separates its DNs with `;`, so
  each base is a whole branch.
  [notes](docs/usage/upgrading.md#trash-watched-bases-are-separated-by-)
  ([#226](https://github.com/linagora/ldap-rest/issues/226))

### Features

- `core/twake/lifecycleEvents`: groups too, with `updated`, `memberAdded`
  and `memberRemoved`, `$changed.` sources and member lists in payloads
  ([#233](https://github.com/linagora/ldap-rest/pull/233)).
  [doc](docs/usage/plugins/integrations/lifecycle-events.md)
- `core/twake/groups`: organization groups, one branch per organization,
  under `/v1/organizations/:id/groups`
  ([#234](https://github.com/linagora/ldap-rest/pull/234)).
  [doc](docs/usage/plugins/integrations/groups.md)
- `abstract/ldapFlat`: `GET /api/v1/ldap/users`, and the list of every other
  flat entity, take `limit` and answer at most that many entries, with
  `X-Result-Truncated: true` when others were left out. The groups list
  does not take it yet —
  [doc](docs/usage/plugins/ldap/flat-generic.md#long-lists)

### Bug Fixes

- `abstract/ldapFlat`: `GET /api/v1/ldap/users`, and the list of every other
  flat entity, answer `422` naming the cause to a list longer than the
  directory's size limit; it was a `500`. The groups list still answers
  `500` —
  [doc](docs/usage/plugins/ldap/flat-generic.md#long-lists)
- `core/auth/openidconnect`: a client asking for JSON only
  (`Accept: application/json`) with no session is answered `401`; it got no
  answer at all
- `core/scim`: `active` reads, filters and clears only the configured
  lock value, so a ppolicy lockout after failed binds reads as active and
  `"active": true` leaves it in place
  ([#232](https://github.com/linagora/ldap-rest/pull/232)).
  [doc](docs/usage/plugins/integrations/scim.md#deactivating-an-account-active)
- `declareObjectClasses` keeps one declaration per base and class set, so
  building the same `LdapFlat` again no longer grows the list
  ([#229](https://github.com/linagora/ldap-rest/issues/229))
- An add writes the entry the `ldapaddrequest` hooks return, the one
  `ldapadddone` and `ldapaddafter` receive; a hook returning a new object
  had its changes dropped
  ([#244](https://github.com/linagora/ldap-rest/issues/244))
- `core/twake/instances`: an organization is linked to its instance before
  its members are sent, which the Cloudery refused otherwise
  ([#236](https://github.com/linagora/ldap-rest/pull/236)).
  [notes](docs/usage/upgrading.md#twakeinstances-links-an-organization-before-its-members)
- `core/twake/groups`: `static/schemas/twake/organizationGroups.json`, a
  group schema for organization groups; the default one refused them
  ([#238](https://github.com/linagora/ldap-rest/issues/238)).
  [doc](docs/usage/plugins/integrations/groups.md)
- `core/twake/groups`: a SCIM group of an organization gets a generated
  `cn`, its SCIM `id`, once `--scim-group-mapping` maps `displayName` to the
  display name attribute, and SCIM no longer refuses a duplicate
  `displayName`. A `scimgroupcreate` hook receives the group base and may
  set the new group's `id`
  ([#239](https://github.com/linagora/ldap-rest/issues/239)).
  [doc](docs/usage/plugins/integrations/groups.md#scim-groups)

## v0.12.0 (2026-09-28)

### Deprecations

- `core/twake/cozyProvision` and `core/twake/clouderyProvision` are replaced
  by `core/twake/instances`, whose options are renamed; the server does not
  start with both —
  [notes](docs/usage/upgrading.md#twakeinstances-replaces-cozyprovision-and-clouderyprovision)

### Features

- `core/auth/openidconnect`: `/logout` also ends the session at the provider
  (RP-Initiated Logout) — [doc](docs/usage/plugins/auth/oidc.md#logout)
  ([#224](https://github.com/linagora/ldap-rest/pull/224))
- `core/twake/lifecycleEvents`: publishes account lifecycle events (created,
  role changed, disabled, enabled, deleted) to RabbitMQ, whichever API wrote
  the entry — [doc](docs/usage/plugins/integrations/lifecycle-events.md)
  ([#203](https://github.com/linagora/ldap-rest/pull/203))
- `core/twake/instances`: each account created through this server gets its
  workplace instance, announced with `user.created` —
  [doc](docs/usage/plugins/integrations/instances.md)
  ([#228](https://github.com/linagora/ldap-rest/pull/228))
- `core/twake/tombstone`: a deleted account stays as a tombstone, its
  identifiers reserved, until an operator erases it —
  [doc](docs/usage/plugins/integrations/tombstone.md)
  ([#204](https://github.com/linagora/ldap-rest/pull/204))
- `ldapaddafter` hook, awaited once an add has written the entry —
  [doc](docs/plugin-development/hooks.md#ldapaddafter)
  ([#227](https://github.com/linagora/ldap-rest/pull/227))

### Bug Fixes

- `core/scim`: two PATCHes removing different members of a group at once no
  longer undo each other —
  [doc](docs/usage/plugins/integrations/scim.md#filter-and-patch-behavior)
  ([#231](https://github.com/linagora/ldap-rest/pull/231))

## v0.11.2 (2026-09-27)

### Bug Fixes

- `core/ldap/flatGeneric`: attaching an account another tool created as a bare
  `inetOrgPerson` no longer fails: a write under a declared branch adds the
  auxiliary class it needs (`--ldap-flat-auto-repair`, on by default), and a
  change the entry cannot hold answers `409` instead of `500` —
  [doc](docs/usage/plugins/ldap/flat-generic.md#entries-created-by-other-tools)
  ([#223](https://github.com/linagora/ldap-rest/pull/223))

## v0.11.1 (2026-09-27)

### Features

- `core/auth/authzLinid1`, `core/auth/authzPerBranch`: a transit branch
  (`--authz-transit-branch`) to hand accounts and groups over between
  organizations; an account attached to none is in transit, option or not —
  [doc](docs/usage/plugins/auth/authz-linid1.md#transit-handing-an-entry-over)
  ([#220](https://github.com/linagora/ldap-rest/issues/220))
- `core/storage`: `postgres` and `valkey` backends —
  [doc](docs/usage/plugins/utilities/storage.md#backends)
  ([#183](https://github.com/linagora/ldap-rest/issues/183))

### Bug Fixes

- authorization by attachment: nobody, a global administrator included, could
  write an entry attached to no organization

## v0.11.0 (2026-09-26)

### Breaking Changes

- `core/auth/authzLinid1` judges accounts and groups by the organization they
  are attached to, whatever `--authz-filter-attached-entries` says — every
  administrator reads the organization tree, and a caller administering no
  branch is refused —
  [notes](docs/usage/upgrading.md#authzlinid1-judges-accounts-and-groups-by-their-organization)
  ([#216](https://github.com/linagora/ldap-rest/issues/216))

### Security

- `core/ldap/groups`: any authenticated caller could list every group and its
  members — [notes](docs/usage/upgrading.md#group-reads-are-judged)
  ([#216](https://github.com/linagora/ldap-rest/issues/216))

### Features

- `core/auth/fake`: a fixed identity for development, refused with
  `NODE_ENV=production` — [doc](docs/usage/plugins/auth/fake.md)

### Bug Fixes

- `core/ldap/organizations`: an entry with a single `objectClass` could not be
  modified (500)

## v0.10.0 (2026-09-26)

### Breaking Changes

- `--ldap-base` (`DM_LDAP_BASE`) is required: the server no longer guesses it
  from `--ldap-dn` —
  [notes](docs/usage/upgrading.md#ldap-base-is-now-required)

- `core/auth/authzPerBranch`: the `groups` rules of
  `--authz-per-branch-config` granted nothing, and now apply
  ([#212](https://github.com/linagora/ldap-rest/issues/212),
  [notes](docs/usage/upgrading.md#group-rules-now-apply))

- A `uid` naming several entries is refused by `core/auth/authzLinid1`, and
  gets no `groups` rule from `core/auth/authzPerBranch`, instead of being
  resolved to whichever entry the server listed first —
  [notes](docs/usage/upgrading.md#an-identity-naming-several-entries-is-refused)

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

- `core/ldap/onChange` publishes `onLdapEntryChange`: the entry before and
  after each add, modify, rename and delete
  ([#206](https://github.com/linagora/ldap-rest/issues/206),
  [doc](docs/usage/plugins/ldap/on-change.md))

- The `ldap*done` hooks and `onLdapEntryChange` receive who made the write
  and through which door (REST or SCIM)
  ([#207](https://github.com/linagora/ldap-rest/issues/207))

- A plugin declares the operational attributes it follows, such as
  `pwdAccountLockedTime`, and `onLdapEntryChange` gives them on both sides
  ([#208](https://github.com/linagora/ldap-rest/issues/208))

### Bug Fixes

- Authorization plugins: a caller renamed, moved to the trash or deleted
  through ldap-rest no longer keeps the rights of its former DN until the
  cache TTL runs out (5 minutes for `core/auth/authzLinid1`)

- `core/auth/authzLinid1`: a failed directory lookup read as an unknown user,
  which `--authz-unresolved-user allow` let through, and was cached. It fails
  the request now, and the next one searches again

- Values written into a search filter unescaped: a DN holding `(` or `)`
  failed the search, and one holding `*` matched nothing
  - `core/ldap/groups`: a deleted entry stayed in its groups
  - `core/ldap/organizations`: an organization looked empty, and was deleted
    with entries still linked to it
  - `core/ldap/departmentSync`: a renamed organization left the links to it
    behind
  - `core/auth/authzLinid1`: an administrator got no permission from the
    organizations naming them

- `core/ldap/groups`: an entry left its groups when its delete was asked for,
  even when the delete was refused, failed, or was turned into a move by
  `core/ldap/trash`. It leaves them once the delete has landed. A group
  losing its last member keeps the `--group-dummy-user` placeholder instead
  of the deleted DN

- `core/ldap/onChange`: a write that leaves every value as it was fires no
  hook, a rename fires them, and a modify of an entry that has children is no
  longer missed. `onLdapDisplayNameChange` fires only when the name changed

- `core/ldap/trash`: moving an entry to the trash fires the `ldaprenamedone`
  hooks, as a rename does

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
